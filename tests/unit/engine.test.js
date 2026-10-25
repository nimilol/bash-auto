// The queue engine against a fake ChatGPT tab: one chat for the run, network loss that uses no
// retries and resends nothing, retries in the same chat, a worker restart mid-run, too-long chats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, outputsFor } from '../../background/engine.js';
import { createStore } from '../../background/store.js';
import { STATUS, makeItems, MODES, normalizeSettings } from '../../lib/utils.js';

const FAST = { poll: 5, pageCheck: 1e9, probe: 5, reload: 20, ready: 500, retryPause: 1, loginCheck: 5 };
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

function memoryStorage(init = {}) {
  const data = structuredClone(init);
  return {
    data,
    async get(keys) {
      const list = typeof keys === 'string' ? [keys] : keys;
      return Object.fromEntries(list.filter((k) => k in data).map((k) => [k, structuredClone(data[k])]));
    },
    async set(obj) { Object.assign(data, structuredClone(obj)); },
    async remove(k) { delete data[k]; },
  };
}

/**
 * A fake chatgpt.com tab. `script(prompt, attempt)` returns the poll answers for one job
 * (the last one repeats). Each answer may use: state, status, kind, error, images.
 */
class FakeTab {
  constructor(script) {
    this.tab = { id: 7, url: 'https://chatgpt.com/', active: true };
    this.script = script;
    this.online = true;
    this.pageUp = true;
    this.convSeq = 0;
    this.sends = []; // { prompt, url, resume }
    this.sentToChat = []; // prompts that actually reached a chat: { prompt, convId }
    this.navigations = [];
    this.attempts = new Map();
    this.jobs = new Map();
    this.loadedAt = 0;
  }

  conv() { return (/\/c\/([\w-]+)/.exec(this.tab.url) || [])[1] || ''; }

  browser() {
    return {
      getTab: async (id) => (id === this.tab.id && !this.closed ? { ...this.tab } : null),
      findChatTabs: async () => (this.closed ? [] : [{ ...this.tab }]),
      createTab: async (url) => { this.closed = false; this.tab.url = url; return { ...this.tab }; },
      navigate: async (id, url) => { this.navigations.push(url); this.tab.url = url; this.loadedAt = Date.now(); return { ...this.tab }; },
      reload: async () => { this.loadedAt = Date.now(); },
      inject: async () => {},
      keepAlive: async () => {},
      activate: async () => {},
      send: async (id, msg) => this.handle(msg),
    };
  }

  async handle(msg) {
    if (!this.pageUp) throw new Error('Could not establish connection. Receiving end does not exist.');
    switch (msg.type) {
      case 'CGA_PING': return { ok: true, ready: true, hook: true, online: this.online, loadedAt: this.loadedAt, url: this.tab.url };
      case 'CGA_PROBE': return { ok: true, online: this.online };
      case 'CGA_NEW_CHAT': this.tab.url = 'https://chatgpt.com/'; return { ok: true };
      case 'CGA_ABORT': return { ok: true };
      case 'CGA_DIAGNOSE': return { ok: true, diagnostics: {} };
      case 'CGA_SUBMIT': {
        const { job } = msg;
        const n = (this.attempts.get(job.prompt) || 0) + 1;
        this.attempts.set(job.prompt, n);
        this.sends.push({ prompt: job.prompt, url: this.tab.url, resume: job.resume, afterId: job.afterId });
        const already = this.sentToChat.some((s) => s.prompt === job.prompt && s.convId === this.conv());
        const steps = this.script(job.prompt, n, { resume: job.resume, already });
        this.jobs.set(job.id, { steps, i: 0, prompt: job.prompt, resume: job.resume, already });
        return { ok: true };
      }
      case 'CGA_POLL': {
        const j = this.jobs.get(msg.id);
        if (!j) return { ok: true, state: 'lost' };
        const step = j.steps[Math.min(j.i, j.steps.length - 1)];
        j.i++;
        if (step.status === 'sent' && !j.sent) {
          j.sent = true;
          if (!(j.resume && j.already)) {
            if (!this.conv()) this.tab.url = `https://chatgpt.com/c/conv-${++this.convSeq}`;
            this.sentToChat.push({ prompt: j.prompt, convId: this.conv() });
          }
        }
        const convId = this.conv();
        const out = { ok: true, state: 'waiting', status: step.status || 'replying', url: this.tab.url, convId, userId: convId ? `u-${j.prompt}-${convId}` : '', online: this.online, notes: [], ...step };
        if (step.state === 'done') out.images = step.images || [{ data: PNG }];
        return out;
      }
      default: return { ok: false };
    }
  }
}

const happy = () => [{ status: 'sent' }, { status: 'image' }, { state: 'done', text: '' }];

async function setup(script, settings = {}, prompts = ['p1', 'p2', 'p3', 'p4', 'p5'], storageInit = {}) {
  const storage = memoryStorage({ settings: normalizeSettings({ minDelay: 0, maxDelay: 0, maxRetries: 2, ...settings }), ...storageInit });
  const store = createStore(storage);
  await store.load();
  if (!storageInit.queue) {
    store.queue.push(...makeItems(prompts, { mode: MODES.TEXT_TO_IMAGE }));
    await store.saveQueue();
  }
  const tab = new FakeTab(script);
  const saved = [];
  const engine = new Engine({ store, browser: tab.browser(), timing: FAST, save: async (item, r) => saved.push([item.index, r.images.length]) });
  return { storage, store, tab, engine, saved };
}

async function untilIdle(engine, ms = 10000) {
  const end = Date.now() + ms;
  while (engine.busy) {
    if (Date.now() > end) throw new Error('engine did not finish');
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('all prompts of a run go into the one chat the first prompt opened', async () => {
  const { store, tab, engine, saved } = await setup(happy);
  await engine.start();
  await untilIdle(engine);
  assert.deepEqual(store.queue.map((i) => i.status), Array(5).fill(STATUS.COMPLETED));
  assert.equal(new Set(store.queue.map((i) => i.convId)).size, 1);
  assert.equal(store.run.convId, 'conv-1');
  assert.deepEqual(tab.sentToChat.map((s) => s.convId), Array(5).fill('conv-1'));
  assert.equal(tab.convSeq, 1, 'only one chat was ever created');
  assert.equal(saved.length, 5);
  // Each prompt after the first is told where the previous one ended (no mixing up older images).
  assert.equal(tab.sends[1].afterId, 'u-p1-conv-1');
});

test('network loss mid-image: waits, uses no retry, resends nothing, continues in the same chat', async () => {
  let offlineFor = 0;
  const { store, tab, engine } = await setup((prompt, n) => {
    if (prompt === 'p2' && n === 1) {
      return [{ status: 'sent' }, { status: 'image' }, { state: 'network', error: 'The browser is offline' }];
    }
    if (prompt === 'p2' && n === 2) return [{ status: 'image' }, { state: 'done' }];
    return happy();
  });
  const origHandle = tab.handle.bind(tab);
  tab.handle = async (msg) => {
    const r = await origHandle(msg);
    if (msg.type === 'CGA_POLL' && r.state === 'network') { tab.online = false; offlineFor = 6; }
    if (msg.type === 'CGA_PROBE' && offlineFor > 0 && --offlineFor === 0) tab.online = true;
    return r;
  };
  const states = new Set();
  const watch = setInterval(() => states.add(store.run.state), 1);
  await engine.start();
  await untilIdle(engine);
  clearInterval(watch);
  assert.ok(states.has('waitingNetwork'), 'went into "waiting for network"');
  const p2 = store.queue[1];
  assert.equal(p2.status, STATUS.COMPLETED);
  assert.equal(p2.retries || 0, 0, 'no retry used');
  assert.equal(tab.sentToChat.filter((s) => s.prompt === 'p2').length, 1, 'p2 reached the chat once');
  assert.equal(tab.sends.filter((s) => s.prompt === 'p2')[1].resume, true, 'second attempt looks for the prompt first');
  assert.ok(tab.sends.filter((s) => s.prompt === 'p2')[1].url.endsWith('/c/conv-1'), 'resumed in the run chat');
  assert.deepEqual(store.queue.map((i) => i.status), Array(5).fill(STATUS.COMPLETED));
  assert.equal(tab.convSeq, 1);
});

test('the ChatGPT page cannot load at all while offline: the run waits, then goes on', async () => {
  const { store, tab, engine } = await setup(happy, {}, ['p1', 'p2']);
  tab.pageUp = false;
  setTimeout(() => { tab.pageUp = true; }, 800);
  await engine.start();
  await untilIdle(engine);
  assert.deepEqual(store.queue.map((i) => i.status), [STATUS.COMPLETED, STATUS.COMPLETED]);
  assert.equal(store.queue[0].retries || 0, 0);
});

test('a failed attempt is retried in the same chat, never in a new one', async () => {
  const { store, tab, engine } = await setup((prompt, n) => (prompt === 'p3' && n === 1
    ? [{ status: 'sent' }, { state: 'error', kind: 'noImage', error: 'No image was generated' }]
    : happy()));
  await engine.start();
  await untilIdle(engine);
  assert.equal(store.queue[2].status, STATUS.COMPLETED);
  assert.equal(store.queue[2].retries, 1);
  assert.ok(tab.sends.filter((s) => s.prompt === 'p3').every((s) => s.url.endsWith('/c/conv-1')));
  assert.equal(tab.convSeq, 1);
});

test('interruptions (stale, page reload) do not use retries and resume instead of resending', async () => {
  const { store, tab, engine } = await setup((prompt, n) => {
    if (prompt === 'p1' && n === 1) return [{ status: 'sent' }, { state: 'error', kind: 'stale', error: 'No progress' }];
    if (prompt === 'p1' && n === 2) return [{ status: 'image' }, { state: 'lost' }];
    return happy();
  }, {}, ['p1']);
  await engine.start();
  await untilIdle(engine);
  const p1 = store.queue[0];
  assert.equal(p1.status, STATUS.COMPLETED);
  assert.equal(p1.retries || 0, 0);
  assert.equal(p1.interruptions, 2);
  assert.equal(tab.sentToChat.length, 1);
  assert.ok(tab.sends.slice(1).every((s) => s.resume));
});

test('retries run out: the prompt is failed and the queue moves on in the same chat', async () => {
  const { store, tab, engine } = await setup((prompt) => (prompt === 'p2'
    ? [{ status: 'sent' }, { state: 'error', kind: 'chatgpt', error: 'ChatGPT error: Something went wrong' }]
    : happy()), { maxRetries: 1 }, ['p1', 'p2', 'p3']);
  await engine.start();
  await untilIdle(engine);
  assert.deepEqual(store.queue.map((i) => i.status), [STATUS.COMPLETED, STATUS.FAILED, STATUS.COMPLETED]);
  assert.equal(tab.sends.at(-1).url, 'https://chatgpt.com/c/conv-1');
});

test('refused twice: skipped', async () => {
  const { store, engine } = await setup((prompt) => (prompt === 'p1' ? [{ status: 'sent' }, { state: 'refused', error: 'Refused' }] : happy()), {}, ['p1', 'p2']);
  await engine.start();
  await untilIdle(engine);
  assert.deepEqual(store.queue.map((i) => i.status), [STATUS.REFUSED, STATUS.COMPLETED]);
  assert.equal(store.queue[0].refusals, 2);
});

test('a new chat per prompt when asked, and "new chat here" on one prompt', async () => {
  const per = await setup(happy, { chatPolicy: 'perPrompt' }, ['a', 'b', 'c']);
  await per.engine.start();
  await untilIdle(per.engine);
  assert.equal(new Set(per.store.queue.map((i) => i.convId)).size, 3);

  const one = await setup(happy, {}, ['a', 'b', 'c', 'd']);
  one.store.queue[2].newChat = true;
  await one.engine.start();
  await untilIdle(one.engine);
  assert.deepEqual(one.store.queue.map((i) => i.convId), ['conv-1', 'conv-1', 'conv-2', 'conv-2']);
});

test('worker restart mid-run: a new engine on the same storage continues without resending', async () => {
  const first = await setup((prompt) => (prompt === 'p2' ? [{ status: 'sent' }, { status: 'image' }] : happy()), {}, ['p1', 'p2', 'p3']);
  await first.engine.start();
  // Wait until p2 has reached the chat, then "kill" the worker.
  while (!first.tab.sentToChat.some((s) => s.prompt === 'p2')) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 30));
  first.engine.stopRequested = true; // the old worker's loop just disappears
  first.engine.wake();
  await untilIdle(first.engine);
  // The new worker reads the saved state. p2 was running.
  const storage = first.storage;
  storage.data.run.state = 'running';
  storage.data.queue[1].status = STATUS.RUNNING;
  const store = createStore(storage);
  await store.load();
  first.tab.script = (prompt) => (prompt === 'p2' ? [{ status: 'image' }, { state: 'done' }] : happy());
  const engine = new Engine({ store, browser: first.tab.browser(), timing: FAST, save: async () => {} });
  assert.equal(await engine.start({ restart: true }), true);
  await untilIdle(engine);
  assert.deepEqual(store.queue.map((i) => i.status), Array(3).fill(STATUS.COMPLETED));
  assert.equal(first.tab.sentToChat.filter((s) => s.prompt === 'p2').length, 1, 'p2 not resent');
  assert.equal(first.tab.convSeq, 1);
});

test('chat too long: pauses; "continue in a new chat" goes on in a new chat', async () => {
  const { store, tab, engine } = await setup((prompt, n) => (prompt === 'p2' && n === 1
    ? [{ status: 'sent' }, { state: 'error', kind: 'tooLong', error: 'Conversation too long' }]
    : happy()), {}, ['p1', 'p2', 'p3']);
  await engine.start();
  await untilIdle(engine);
  assert.equal(store.run.state, 'paused');
  assert.equal(store.queue[1].status, STATUS.QUEUED);
  await engine.newChat();
  await untilIdle(engine);
  assert.deepEqual(store.queue.map((i) => i.status), Array(3).fill(STATUS.COMPLETED));
  assert.equal(store.queue[1].convId, 'conv-2');
  assert.equal(store.queue[2].convId, 'conv-2');
  assert.equal(tab.convSeq, 2);
});

test('Stop mid-prompt, then Run: picked up, not resent', async () => {
  const { store, tab, engine } = await setup((prompt, n) => (n === 1 ? [{ status: 'sent' }, { status: 'image' }] : [{ status: 'image' }, { state: 'done' }]), {}, ['p1']);
  await engine.start();
  while (!tab.sentToChat.length) await new Promise((r) => setTimeout(r, 5));
  await engine.stop();
  await untilIdle(engine);
  assert.equal(store.queue[0].status, STATUS.QUEUED);
  assert.equal(store.run.state, 'idle');
  await engine.start();
  await untilIdle(engine);
  assert.equal(store.queue[0].status, STATUS.COMPLETED);
  assert.equal(tab.sentToChat.length, 1);
  assert.equal(tab.sends[1].resume, true);
});

test('outputsFor: file names for images and text', () => {
  const s = normalizeSettings({ folder: 'Out' });
  const item = { index: 4, prompt: 'Blue cat', mode: MODES.TEXT_TO_IMAGE, copy: 0 };
  const files = outputsFor(item, { images: [{ data: PNG }, { url: 'https://x.test/a.webp' }] }, s);
  assert.deepEqual(files.map((f) => f.filename), ['Out/005-blue-cat.png', 'Out/005-blue-cat-2.webp']);
  const text = outputsFor({ ...item, mode: MODES.TEXT }, { text: 'hello', images: [] }, s);
  assert.equal(text[0].filename, 'Out/005-blue-cat.md');
  assert.match(text[0].text, /# Response\n\nhello/);
});
