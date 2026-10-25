// The queue engine. Runs in the service worker, so it keeps going when the panel is closed, and
// picks the run up again if the browser restarts the worker (state is saved after every step).
//
// One ChatGPT tab, one prompt at a time, and by default one chat for the whole run: once the first
// prompt lands in a chat, every later prompt, retry and recovery goes to that same chat.
//
// For each prompt: get the tab onto the right chat, hand the prompt to the tab's content script
// (CGA_SUBMIT), then ask it how it's going every 1.5 s (CGA_POLL) until it reports done, refused,
// a network problem or an error. Network problems never use up retries: the engine waits for the
// connection to come back, reloads the chat and carries on from where it was.
import {
  STATUS, buildFilename, buildRequest, chatUrlFor, chooseChat, conversationId, expectsImages, extFromMime, extFromUrl,
  formatDuration, isChatUrl, itemLabel, mimeFromDataUrl, randomDelay, MODES,
} from '../lib/utils.js';
import { IDLE_RUN } from './store.js';

const TIMING = Object.freeze({
  poll: 1500, // how often the tab is asked how the prompt is going
  pageCheck: 60000, // a "check" line in the log this often while a prompt runs
  probe: 5000, // connectivity probe while waiting for the network
  reload: 15000, // reload a tab that can't load while waiting for the network
  ready: 45000, // wait this long for the ChatGPT page to be usable
  retryPause: 3000,
  loginCheck: 5000,
});
const MAX_INTERRUPTIONS = 6; // per prompt, on top of its retries
const MAX_REFUSALS = 1; // a refused prompt is tried once more, then skipped
// After these, the prompt is simply sent again: the earlier attempt left nothing in the chat to follow.
const RESEND_KINDS = new Set(['lost', 'send', 'refused', 'tooLong', 'config']);
// After these, the chat is checked first, and the earlier attempt is only followed if an image
// arrived late or ChatGPT is still working on it; otherwise the prompt is sent again.
const LOOK_KINDS = new Set(['noImage', 'chatgpt']);
const INTERRUPT_KINDS = new Set(['interrupted', 'stale', 'cap', 'tab', 'stopped', 'replaced', 'recover']);

export class Engine {
  /**
   * env: {
   *   store,                      see store.js
   *   browser: { getTab, findChatTabs, createTab, navigate, reload, send, inject, keepAlive, activate, ping? },
   *   save(item, result, settings),   downloads the outputs
   *   sleepChunk(ms),             a sleep that keeps the service worker alive (default setTimeout)
   *   now(),                      clock (tests)
   *   onChange(),                 something the panel shows changed
   * }
   */
  constructor(env) {
    this.env = env;
    this.store = env.store;
    this.b = env.browser;
    this.now = env.now || Date.now;
    this.looping = false;
    this.stopRequested = false;
    this.wakers = new Set();
    this.reloadNext = false;
    this.t = { ...TIMING, ...(env.timing || {}) };
  }

  log(kind, text) {
    this.store.log(kind, text);
    this.env.onChange?.();
  }

  get run() {
    return this.store.run;
  }

  get busy() {
    return this.looping;
  }

  // ---- Commands --------------------------------------------------------------------------------

  /** Start (or continue) the run. `restart`: the service worker woke up mid-run. */
  async start({ restart = false } = {}) {
    if (this.looping) return false;
    this.looping = true; // set before any await, so two starts can't both get through
    await this.store.load();
    if (!this.store.queue.some((i) => i.status === STATUS.QUEUED || i.status === STATUS.RUNNING)) {
      this.looping = false;
      if (!restart) this.log('warn', 'Nothing to run: add prompts first.');
      await this.store.setRun({ state: 'idle', currentId: '' });
      return false;
    }
    this.stopRequested = false;
    await this.store.setRun({ state: 'running', pause: '', message: '', startedAt: restart && this.run.startedAt ? this.run.startedAt : this.now() });
    this.log('info', restart ? 'Continuing the run (the extension\'s background worker was restarted).' : 'Run started.');
    this.loop().catch((e) => this.log('error', `Unexpected error: ${e?.stack || e}`));
    return true;
  }

  async stop() {
    await this.store.load();
    if (!this.looping) {
      await this.store.setRun({ state: 'idle', pause: '', message: '' });
      return;
    }
    this.stopRequested = true;
    await this.store.setRun({ state: 'stopping' });
    this.wake();
    // ChatGPT is left to finish what it's drawing; the next Run collects it instead of resending.
    if (this.run.tabId != null) this.b.send(this.run.tabId, { type: 'CGA_ABORT' }).catch(() => {});
    this.env.onChange?.();
  }

  /** Reload the ChatGPT tab and pick up the current prompt again (nothing is resent if it's in the chat). */
  async recover() {
    if (this.following) {
      this.recoverRequested = true;
      this.wake();
      this.log('info', 'Recovering: reloading the chat and picking the prompt up again.');
      return;
    }
    this.reloadNext = true;
    this.log('info', 'The chat will be reloaded before the next prompt.');
  }

  /** Forget the run's chat: the next prompt starts a new one, and the run continues there. */
  async newChat() {
    await this.store.load();
    await this.store.setRun({ convId: '', chatUrl: '', lastAnchorId: '' });
    this.log('info', 'The next prompt will start a new chat; the following prompts continue in it.');
    if (this.run.state === 'paused') await this.start();
    this.env.onChange?.();
  }

  wake() {
    this.wakers.forEach((w) => w());
  }

  /** Sleep that Stop and Recover cut short, in chunks that keep the service worker alive. */
  async sleep(ms) {
    const end = this.now() + ms;
    while (!this.stopRequested && !this.recoverRequested && this.now() < end) {
      const chunk = Math.min(end - this.now(), 10000);
      await new Promise((resolve) => {
        const done = () => {
          clearTimeout(t);
          this.wakers.delete(done);
          resolve();
        };
        const t = setTimeout(done, chunk);
        this.wakers.add(done);
      });
      this.b.keepAlive?.();
    }
  }

  // ---- The loop ----------------------------------------------------------------------------------

  next() {
    const q = this.store.queue;
    return q.find((i) => i.status === STATUS.RUNNING) || q.find((i) => i.status === STATUS.QUEUED) || null;
  }

  async loop() {
    let finished = false;
    try {
      for (;;) {
        if (this.stopRequested) break;
        const item = this.next();
        if (!item) {
          finished = true;
          break;
        }
        const result = await this.attempt(item);
        if (this.stopRequested) {
          await this.requeue(item, result);
          break;
        }
        const goOn = await this.handle(item, result);
        if (!goOn) break;
        if (result.kind === 'done' && this.next()) {
          const settings = await this.store.settings();
          const ms = randomDelay(settings.minDelay, settings.maxDelay);
          if (ms > 0) {
            await this.store.setRun({ waitUntil: this.now() + ms });
            this.env.onChange?.();
            await this.sleep(ms);
            await this.store.setRun({ waitUntil: 0 });
          }
        }
      }
    } finally {
      this.looping = false;
      const stopped = this.stopRequested;
      this.stopRequested = false;
      let dirty = false;
      for (const i of this.store.queue) {
        if (i.status === STATUS.RUNNING) {
          Object.assign(i, { status: STATUS.QUEUED, phase: '' });
          dirty = true;
        }
      }
      if (dirty) await this.store.saveQueue();
      if (this.run.state !== 'paused') await this.store.setRun({ state: 'idle', currentId: '', waitUntil: 0, message: '' });
      else await this.store.setRun({ currentId: '', waitUntil: 0 });
      if (stopped) this.log('info', 'Stopped. Run continues where it stopped; a prompt ChatGPT is still working on is collected, not sent again.');
      else if (finished) {
        const c = this.store.queue.reduce((acc, i) => ({ ...acc, [i.status]: (acc[i.status] || 0) + 1 }), {});
        this.log('success', `Run finished: ${c.completed || 0} completed, ${c.failed || 0} failed, ${c.refused || 0} refused.`);
      }
      await this.store.flushLog?.();
      this.env.onChange?.();
    }
  }

  /** A prompt that was running when Stop was pressed goes back to the queue, ready to be resumed. */
  async requeue(item, result) {
    if (result?.kind === 'done') {
      await this.handle(item, result);
      return;
    }
    if (item.status === STATUS.RUNNING) {
      Object.assign(item, { status: STATUS.QUEUED, phase: '', lastKind: 'stopped' });
      await this.store.saveQueue();
    }
  }

  // ---- One attempt at one prompt -----------------------------------------------------------------

  async attempt(item) {
    const settings = await this.store.settings();
    const label = itemLabel(item);
    let request;
    try {
      const assets = await this.store.assets();
      const prev = item.imageMode === 'last' ? await this.store.lastImage() : null;
      request = buildRequest(item, settings, assets, prev, new Set(this.store.queue.map((i) => i.index)).size);
    } catch (e) {
      return { kind: 'config', error: String(e?.message || e) };
    }
    Object.assign(item, { status: STATUS.RUNNING, phase: 'preparing', error: '', startedAt: item.startedAt || this.now() });
    await this.store.saveQueue();
    await this.store.setRun({ currentId: item.id });
    this.log('info', `Prompt ${label}: ${item.attempts ? 'trying again' : 'starting'}.`);
    item.attempts = (item.attempts || 0) + 1;

    const target = chooseChat(item, this.run, settings);
    const prep = await this.prepareTab(target, settings, expectsImages(item.mode));
    if (prep.kind) return prep;
    const tabId = prep.tabId;

    // The prompt may have reached ChatGPT before (an interruption, Stop, a closed tab): look first.
    const resume = !!item.submittedAt && !RESEND_KINDS.has(item.lastKind || '');
    const sameChat = item.convId ? item.convId === this.run.convId : target.kind === 'chat' && target.convId === this.run.convId;
    const image = expectsImages(item.mode);
    const job = {
      id: crypto.randomUUID(),
      prompt: request.prompt,
      files: request.files, // only used when the prompt has to be sent
      expectImages: request.expectImages,
      resume,
      resumeStrict: LOOK_KINDS.has(item.lastKind || ''),
      userId: resume ? item.userMsgId || '' : '',
      afterId: sameChat ? this.run.lastAnchorId : '',
      timings: image
        ? { quietMs: settings.noImageQuietMin * 60000, capMs: settings.imageWaitMin * 60000, staleMs: Math.min(settings.imageWaitMin * 60000, 10 * 60000) }
        : { quietMs: 3 * 60000, capMs: settings.textTimeoutMin * 60000, staleMs: Math.min(settings.textTimeoutMin * 60000, 5 * 60000) },
    };
    item.submittedAt = item.submittedAt || this.now();
    item.lastKind = '';
    await this.store.saveQueue();
    const ok = await this.b.send(tabId, { type: 'CGA_SUBMIT', job }).catch((e) => ({ ok: false, error: String(e?.message || e) }));
    if (!ok?.ok) return { kind: 'tab', error: ok?.error || 'The ChatGPT tab did not answer' };
    this.following = true;
    try {
      return await this.follow(item, tabId, job, label, target);
    } finally {
      this.following = false;
    }
  }

  /** Poll the job until it ends. */
  async follow(item, tabId, job, label, target) {
    const hardEnd = this.now() + job.timings.capMs + 5 * 60000;
    let misses = 0;
    let notesSeen = 0;
    let lastStatus = '';
    let nextCheck = this.now() + this.t.pageCheck;
    for (;;) {
      await this.sleep(this.t.poll);
      if (this.stopRequested) return { kind: 'stopped' };
      if (this.recoverRequested) {
        this.recoverRequested = false;
        this.reloadNext = true;
        return { kind: 'recover', error: 'Recover pressed' };
      }
      const r = await this.b.send(tabId, { type: 'CGA_POLL', id: job.id }).catch((e) => ({ transport: String(e?.message || e) }));
      if (!r || r.transport) {
        misses++;
        const tab = await this.b.getTab(tabId);
        if (!tab) return { kind: 'tab', error: 'The ChatGPT tab was closed' };
        if (misses >= 8) return { kind: 'interrupted', error: 'The ChatGPT page stopped answering (reloaded or lost its connection)', probe: true };
        continue;
      }
      misses = 0;
      if (r.state === 'lost') return { kind: 'interrupted', error: 'The ChatGPT page was reloaded while the prompt was running' };
      await this.learn(item, r, target);
      if (r.status && r.status !== lastStatus) {
        lastStatus = r.status;
        item.phase = r.status;
        await this.store.saveQueue();
        if (r.status === 'sent') this.log('info', `Prompt ${label}: sent.`);
        if (r.status === 'image') this.log('info', `Prompt ${label}: ChatGPT is generating the image…`);
        if (r.status === 'nudged') this.log('info', `Prompt ${label}: ChatGPT answered without an image; asked it once to generate it.`);
        this.env.onChange?.();
      }
      for (const text of (r.notes || []).slice(notesSeen)) this.log('info', `Prompt ${label}: ${text}.`);
      notesSeen = (r.notes || []).length;
      switch (r.state) {
        case 'done':
          return { kind: 'done', text: r.text || '', images: r.images || [], thumbs: r.thumbs || [], source: r.source, resumed: r.resumed };
        case 'refused':
          return { kind: 'refused', error: r.error, text: r.text };
        case 'network':
          return { kind: 'network', error: r.error };
        case 'error':
          return { kind: r.kind || 'error', error: r.error };
        default:
          break;
      }
      if (r.online === false) return { kind: 'network', error: 'The browser is offline' };
      if (this.now() > hardEnd) return { kind: 'cap', error: 'Timed out waiting for the reply' };
      if (this.now() >= nextCheck) {
        nextCheck = this.now() + this.t.pageCheck;
        this.pageCheck(tabId, label);
      }
    }
  }

  /** Remember where the prompt landed as soon as the tab knows: chat id and message id. */
  async learn(item, r, target) {
    let dirty = false;
    const convId = r.convId || conversationId(r.url);
    if (convId && item.convId !== convId && r.sent !== false) {
      item.convId = convId;
      item.chatUrl = chatUrlFor(convId, r.url);
      dirty = true;
    }
    if (r.userId && item.userMsgId !== r.userId) {
      item.userMsgId = r.userId;
      dirty = true;
    }
    if (dirty) await this.store.saveQueue();
    // The run's chat is the one a prompt opened (new chat, or the chat that was open). Going back
    // to an existing chat never changes it, so "Start new chat" pressed mid-prompt holds.
    if (convId && target.kind !== 'chat' && this.run.convId !== convId && (await this.store.settings()).chatPolicy === 'same') {
      await this.store.setRun({ convId, chatUrl: chatUrlFor(convId, r.url), lastAnchorId: '' });
      this.log('info', `Chat for this run: ${chatUrlFor(convId, r.url)}`);
    }
  }

  async pageCheck(tabId, label) {
    const res = await this.b.send(tabId, { type: 'CGA_DIAGNOSE' }).catch(() => null);
    const d = res?.diagnostics;
    if (!d?.job) return;
    const j = d.job;
    const s = d.streams?.[d.streams.length - 1];
    const parts = [
      `${j.phase}/${j.decision || '-'}`,
      `hook ${d.hook ? '✓' : '✗'}`,
      `stream ${s ? (s.open ? 'open' : `closed${s.aborted ? ' (aborted)' : ''}`) : '-'}`,
      `chat data ${j.json ? `${j.json.anchor ? '' : 'prompt not found, '}${j.json.inProgress ? 'in progress' : j.json.final ? 'final' : 'waiting'}, ${j.json.images || 0} img` : 'n/a'}`,
      `page ${j.dom ? `${j.dom.images} img${j.dom.generating ? ', generating' : ''}${j.dom.stop ? ', stop' : ''}` : '-'}`,
      `quiet ${j.quietSecs}s`,
      `tab ${d.visibility}${d.online ? '' : ' offline'}`,
    ];
    this.log('info', `Prompt ${label} check: ${parts.join(' · ')}`);
  }

  // ---- After an attempt ------------------------------------------------------------------------

  /** Updates the item from the attempt's result. Returns false when the run must pause or stop. */
  async handle(item, r) {
    const label = itemLabel(item);
    const settings = await this.store.settings();
    item.phase = '';
    if (r.kind === 'done') {
      Object.assign(item, {
        status: STATUS.COMPLETED,
        finishedAt: this.now(),
        output: String(r.text || '').slice(0, 20000),
        imageCount: r.images.length,
        thumbs: (r.thumbs || []).filter(Boolean).slice(0, 4),
        error: '',
        lastKind: '',
      });
      await this.store.saveQueue();
      if (item.convId && settings.chatPolicy === 'same' && item.convId === this.run.convId && item.userMsgId) {
        await this.store.setRun({ lastAnchorId: item.userMsgId });
      }
      const took = formatDuration(this.now() - (item.startedAt || this.now()));
      this.log('success', `Prompt ${label}: done in ${took}${r.images.length ? `, ${r.images.length} image${r.images.length > 1 ? 's' : ''}` : ''}${r.resumed ? ' (picked up after an interruption)' : ''}.`);
      if (expectsImages(item.mode) && r.images.length) {
        const last = r.images[r.images.length - 1];
        if (last?.data) await this.store.setLastImage({ name: `previous-image-${item.index + 1}.png`, dataUrl: last.data });
      }
      try {
        await this.env.save(item, r, settings);
      } catch (e) {
        this.log('error', `Prompt ${label}: saving failed: ${e?.message || e}`);
      }
      this.env.onChange?.();
      return true;
    }

    item.lastKind = r.kind;
    item.error = r.error || 'Unknown error';

    if (r.kind === 'network' || r.probe) {
      // The prompt stays where it is; nothing is used up. Wait for the connection, then resume.
      item.phase = 'network';
      await this.store.saveQueue();
      this.log('warn', `Prompt ${label}: ${item.error}. Waiting for the connection to come back (nothing is skipped or failed).`);
      if (!(await this.waitForNetwork(item))) return false;
      item.lastKind = 'interrupted';
      item.status = STATUS.RUNNING;
      await this.store.saveQueue();
      return true;
    }
    if (r.kind === 'login') {
      this.log('warn', 'ChatGPT needs you to log in. Log in in the ChatGPT tab; the run continues by itself.');
      item.lastKind = 'interrupted';
      return this.waitForLogin();
    }
    if (r.kind === 'tooLong') {
      Object.assign(item, { status: STATUS.QUEUED, convId: '', chatUrl: '', submittedAt: 0, userMsgId: '' });
      await this.store.saveQueue();
      await this.store.setRun({ state: 'paused', pause: 'tooLong', message: 'This chat has reached ChatGPT\'s length limit. Click "Continue in a new chat" to go on.' });
      this.log('warn', `Prompt ${label}: the chat is too long for ChatGPT. Paused; click "Continue in a new chat" to go on in a new chat.`);
      return false;
    }
    if (r.kind === 'config') {
      item.status = STATUS.FAILED;
      await this.store.saveQueue();
      this.log('error', `Prompt ${label}: ${item.error}`);
      return true;
    }
    if (r.kind === 'refused') {
      item.refusals = (item.refusals || 0) + 1;
      const skip = item.refusals > MAX_REFUSALS;
      item.status = skip ? STATUS.REFUSED : STATUS.RUNNING;
      await this.store.saveQueue();
      this.log('warn', skip ? `Prompt ${label}: refused by ChatGPT again — skipped.` : `Prompt ${label}: refused by ChatGPT — trying once more.`);
      return true;
    }
    if (INTERRUPT_KINDS.has(r.kind) && (item.interruptions || 0) < MAX_INTERRUPTIONS) {
      item.interruptions = (item.interruptions || 0) + 1;
      item.status = STATUS.RUNNING;
      this.reloadNext = true;
      await this.store.saveQueue();
      this.log('warn', `Prompt ${label}: ${item.error}. Reloading the chat and picking it up again (it is not sent twice).`);
      return true;
    }
    // A real failure: use a retry.
    item.retries = (item.retries || 0) + 1;
    const failed = item.retries > settings.maxRetries;
    item.status = failed ? STATUS.FAILED : STATUS.RUNNING;
    await this.store.saveQueue();
    if (failed) {
      this.log('error', `Prompt ${label}: failed after ${settings.maxRetries} retr${settings.maxRetries === 1 ? 'y' : 'ies'}: ${item.error}`);
      return true;
    }
    this.log('warn', `Prompt ${label}: ${item.error} — retry ${item.retries}/${settings.maxRetries}.`);
    this.reloadNext = true;
    if (/rate limit|too many requests|reached (our|the|your)|usage cap|limit of/i.test(item.error)) {
      const wait = Math.min(15 * 60000, 60000 * 2 ** (item.retries - 1));
      this.log('warn', `ChatGPT is limiting requests: waiting ${formatDuration(wait)} before the retry.`);
      await this.store.setRun({ waitUntil: this.now() + wait });
      await this.sleep(wait);
      await this.store.setRun({ waitUntil: 0 });
    } else {
      await this.sleep(this.t.retryPause);
    }
    return true;
  }

  // ---- The ChatGPT tab -------------------------------------------------------------------------

  /** The tab the run uses: the one it used before, else the ChatGPT tab in front, any ChatGPT tab, or a new one. */
  async pickTab() {
    if (this.run.tabId != null) {
      const tab = await this.b.getTab(this.run.tabId);
      if (tab) return tab;
    }
    const tabs = await this.b.findChatTabs();
    const tab = tabs.find((t) => t.active) || tabs[0] || (await this.b.createTab(chatUrlFor(this.run.convId), true));
    await this.store.setRun({ tabId: tab.id });
    return tab;
  }

  /**
   * Gets the tab onto the right chat with a working content script.
   * Returns { tabId } or a failure result { kind: 'network' | 'login', error }.
   */
  async prepareTab(target, settings, image) {
    let tab = await this.pickTab();
    const reload = this.reloadNext;
    this.reloadNext = false;
    const origin = isChatUrl(tab.url) ? new URL(tab.url).origin : 'https://chatgpt.com';
    let url = '';
    if (target.kind === 'chat') {
      if (conversationId(tab.url) !== target.convId || reload || !isChatUrl(tab.url)) url = chatUrlFor(target.convId, tab.url);
    } else if (target.kind === 'new') {
      const model = settings.model;
      if (model) url = `${origin}/?model=${encodeURIComponent(model)}`;
      else if (reload || !isChatUrl(tab.url)) url = `${origin}/`;
      else {
        const ready = await this.ensureAgent(tab.id, 0, 8000);
        const soft = ready.ok ? await this.b.send(tab.id, { type: 'CGA_NEW_CHAT' }).catch(() => null) : null;
        if (!soft?.ok) url = `${origin}/`;
      }
    } else if (!isChatUrl(tab.url)) url = `${origin}/`;
    else if (reload) url = tab.url;

    let freshAfter = 0;
    if (url) {
      if (target.kind === 'chat' && conversationId(tab.url) !== target.convId) this.log('info', 'Opening the run\'s chat.');
      freshAfter = this.now();
      tab = (await this.b.navigate(tab.id, url)) || tab;
    }
    if (settings.keepTabActive) await this.b.activate?.(tab.id).catch(() => {});
    await this.b.keepAlive?.(tab.id);
    const ready = await this.ensureAgent(tab.id, freshAfter, this.t.ready);
    if (ready.ok) return { tabId: tab.id };
    if (ready.login) return { kind: 'login', error: 'Log in to ChatGPT' };
    return { kind: 'network', error: 'The ChatGPT page did not load' };
  }

  /** Wait until the tab's content script answers with a prompt box; inject the scripts if needed. */
  async ensureAgent(tabId, freshAfter, timeout) {
    const end = this.now() + timeout;
    let lastInject = 0;
    let hookInjected = false;
    let last = null;
    while (this.now() < end && !this.stopRequested) {
      const res = await this.b.send(tabId, { type: 'CGA_PING' }).catch(() => null);
      last = res;
      const fresh = !freshAfter || (res?.loadedAt || 0) >= freshAfter - 1000;
      if (res?.ok && fresh) {
        if (!res.hook && !hookInjected) {
          hookInjected = true;
          await this.b.inject(tabId, 'main').catch(() => {});
        }
        if (res.online === false) return { ok: false, offline: true };
        if (res.ready) return { ok: true, ...res };
        if (res.login) return { ok: false, login: true };
      }
      if (!res && this.now() - lastInject > 4000) {
        lastInject = this.now();
        await this.b.inject(tabId, 'all').catch(() => {});
      }
      await this.sleep(Math.min(400, this.t.poll));
    }
    return { ok: false, login: !!last?.login };
  }

  /** Wait (without limit; Stop ends it) until ChatGPT can be reached from the tab twice in a row. */
  async waitForNetwork() {
    await this.store.setRun({ state: 'waitingNetwork', message: 'Waiting for the internet connection…' });
    this.env.onChange?.();
    const since = this.now();
    let good = 0;
    let lastReload = this.now();
    let lastNote = this.now();
    while (!this.stopRequested) {
      await this.sleep(this.t.probe);
      if (this.stopRequested) break;
      let tab = this.run.tabId != null ? await this.b.getTab(this.run.tabId) : null;
      if (!tab) {
        tab = await this.b.createTab(chatUrlFor(this.run.convId), false).catch(() => null);
        if (tab) await this.store.setRun({ tabId: tab.id });
        lastReload = this.now();
        continue;
      }
      const ping = await this.b.send(tab.id, { type: 'CGA_PING' }).catch(() => null);
      if (ping?.ok) {
        const probe = await this.b.send(tab.id, { type: 'CGA_PROBE' }).catch(() => null);
        good = probe?.online ? good + 1 : 0;
      } else {
        good = 0;
        if (this.now() - lastReload >= this.t.reload) {
          lastReload = this.now();
          const url = this.run.convId ? chatUrlFor(this.run.convId, tab.url) : (isChatUrl(tab.url) ? tab.url : 'https://chatgpt.com/');
          await this.b.navigate(tab.id, url).catch(() => {});
        }
      }
      if (good >= 2) {
        this.log('success', `Connection is back after ${formatDuration(this.now() - since)}. Reloading the chat and continuing.`);
        this.reloadNext = true;
        await this.store.setRun({ state: 'running', message: '' });
        this.env.onChange?.();
        return true;
      }
      if (this.now() - lastNote >= 60000) {
        lastNote = this.now();
        this.log('info', `Still waiting for the connection (${formatDuration(this.now() - since)}).`);
      }
    }
    return false;
  }

  async waitForLogin() {
    await this.store.setRun({ state: 'waitingLogin', message: 'Log in to ChatGPT in the ChatGPT tab.' });
    this.env.onChange?.();
    while (!this.stopRequested) {
      await this.sleep(this.t.loginCheck);
      const tab = this.run.tabId != null ? await this.b.getTab(this.run.tabId) : null;
      if (!tab) continue;
      const ping = await this.b.send(tab.id, { type: 'CGA_PING' }).catch(() => null);
      if (ping?.ok && ping.ready && !ping.login) {
        this.log('success', 'Logged in. Continuing.');
        await this.store.setRun({ state: 'running', message: '' });
        this.env.onChange?.();
        return true;
      }
    }
    return false;
  }

  /** What the panel's "Copy diagnostics" includes about the page. */
  async diagnostics() {
    const tabId = this.run.tabId;
    if (tabId == null) return null;
    const res = await this.b.send(tabId, { type: 'CGA_DIAGNOSE' }).catch(() => null);
    return res?.diagnostics || null;
  }
}

/** Files to save for a finished item: [{ filename, data?, url?, text? }]. Pure, unit-tested. */
export function outputsFor(item, result, settings) {
  const common = { folder: settings.folder, index: item.index, prompt: item.prompt, rename: settings.renameFiles, copy: item.copy };
  const out = [];
  const images = result.images || [];
  if (settings.saveImages) {
    images.forEach((img, k) => {
      const part = images.length > 1 ? k : 0;
      if (img.data && /^data:/.test(img.data)) out.push({ filename: buildFilename({ ...common, ext: extFromMime(mimeFromDataUrl(img.data)), part }), data: img.data, url: img.url || '' });
      else if (img.url) out.push({ filename: buildFilename({ ...common, ext: extFromUrl(img.url), part }), url: img.url });
    });
  }
  const textMode = item.mode === MODES.TEXT || item.mode === MODES.INGREDIENTS;
  if (textMode && result.text && settings.saveText !== 'none') {
    const md = settings.saveText === 'md';
    out.push({
      filename: buildFilename({ ...common, ext: md ? 'md' : 'txt' }),
      text: md ? `# Prompt\n\n${item.prompt}\n\n# Response\n\n${result.text}\n` : `${result.text}\n`,
      mime: md ? 'text/markdown' : 'text/plain',
    });
  }
  return out;
}

export { IDLE_RUN };
