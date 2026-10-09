// Queue engine. Lives in the side panel page (or the pop-out window), which stays alive while open.
// Runs "Concurrent prompts" workers, each with its own chatgpt.com tab. A worker hands one prompt
// at a time to the tab's content script (CGA_SUBMIT) and then asks how it's going every
// POLL_MS (CGA_POLL) until the reply is done. Each message is short, so a reloaded or closed tab
// shows up within seconds instead of leaving the queue waiting on a reply that will never come.
import { api } from '../lib/browser.js';
import { STATUS, buildFilename, extFromMime, itemLabel, mimeFromDataUrl, randomDelay, sleep } from '../lib/utils.js';
import { MODES, buildRequest, expectsImages, startsNewChat } from './modes.js';

const CHAT_URL = 'https://chatgpt.com/';
const CHAT_HOSTS = ['https://chatgpt.com/', 'https://chat.openai.com/'];
const isChatUrl = (url) => CHAT_HOSTS.some((h) => String(url || '').startsWith(h));
const CONTENT_MAIN = ['content/sse.js', 'content/net-hook.js'];
const CONTENT_ISOLATED = ['content/selectors.js', 'content/conversation.js', 'content/agent.js'];

const LOCK_NAME = 'cga-engine';
const POLL_MS = 1500;
const PAGE_CHECK_MS = 60000; // a "Page check" line in the log this often while a prompt runs
const MAX_INTERRUPTIONS = 5; // per prompt, on top of the normal retries
const REFUSAL_RETRIES = 1;

/** "/c/<id>" conversation id (also inside project/GPT paths), or null for a blank chat. */
export function conversationId(url) {
  const m = /\/c\/([\w-]+)/.exec(String(url || ''));
  return m ? m[1] : null;
}

/** Did the prompt possibly reach the chat? Then the next attempt follows its reply instead of resending. */
export function wasInterrupted(result) {
  if (result.interrupted) return true;
  return result.stage === 'reply';
}

export class Engine {
  /**
   * @param store  { getQueue, saveQueue, getSettings, getAssets, getLastImage, setLastImage }
   * @param hooks  { onChange(), onLog(kind, key, params) }
   */
  constructor(store, hooks) {
    this.store = store;
    this.hooks = hooks;
    this.state = 'idle'; // idle | running | stopping
    this.stopRequested = false;
    this.workers = [];
    this.wakers = new Set();
    this.discardGuarded = new Set();
  }

  get busy() {
    return this.state !== 'idle';
  }

  log(kind, key, params) {
    this.hooks.onLog?.(kind, key, params);
  }

  changed() {
    this.hooks.onChange?.();
  }

  /** Items being worked on right now, with what each is doing. */
  get active() {
    return this.workers.filter((w) => w.item).map((w) => ({ id: w.item.id, status: w.status, mode: w.mode }));
  }

  async start() {
    if (this.busy) return;
    this.stopRequested = false;
    this.hiddenWarned = false;
    this.waitUntil = 0;
    this.state = 'running';
    this.changed();
    let ran = false;
    try {
      // One engine per browser profile: a second open panel must not drive the same queue.
      ran = await withLock(async () => {
        this.log('info', 'logStarted');
        await this.run();
      });
      if (!ran) this.log('warn', 'logAlreadyRunning');
    } catch (e) {
      this.log('error', 'logFatal', [String(e?.message || e)]);
    } finally {
      for (const id of this.discardGuarded) await api.tabs.update(id, { autoDiscardable: true }).catch(() => {});
      this.discardGuarded.clear();
      const stopped = this.stopRequested;
      this.workers = [];
      this.state = 'idle';
      this.changed();
      if (ran && !stopped) this.log('success', 'logFinished');
    }
  }

  async stop() {
    if (!this.busy) return;
    this.stopRequested = true;
    this.state = 'stopping';
    this.wakers.forEach((wake) => wake());
    // ChatGPT is left to finish the reply it's writing: Run collects it instead of sending again.
    const chats = new Map();
    for (const w of this.workers) {
      if (w.tabId != null) api.tabs.sendMessage(w.tabId, { type: 'CGA_STOP' }).catch(() => {});
      if (w.item && conversationId(w.chatUrl)) chats.set(w.item.id, w.chatUrl);
    }
    const queue = await this.store.getQueue();
    for (const item of queue) {
      if (item.status !== STATUS.RUNNING) continue;
      Object.assign(item, { status: STATUS.QUEUED, interrupted: true });
      if (chats.has(item.id)) item.chatUrl = chats.get(item.id);
    }
    await this.store.saveQueue(queue);
    this.log('info', 'logStopped');
    this.changed();
  }

  /**
   * "Fix Error": stop what ChatGPT is doing, close dialogs, reload the tabs, and run the stuck
   * prompts again (without using up their retries).
   */
  async fix() {
    this.log('info', 'logFixing');
    if (this.busy) {
      for (const w of this.workers) {
        w.fixRequested = true;
        if (w.tabId != null) await api.tabs.sendMessage(w.tabId, { type: 'CGA_FIX' }).catch(() => {});
      }
      this.wakers.forEach((wake) => wake());
      return;
    }
    const tabs = await api.tabs.query({ url: CHAT_HOSTS.map((h) => `${h}*`) }).catch(() => []);
    for (const tab of tabs) {
      await api.tabs.sendMessage(tab.id, { type: 'CGA_FIX' }).catch(() => {});
      await api.tabs.reload(tab.id).catch(() => {});
    }
    const queue = await this.store.getQueue();
    for (const item of queue) {
      if (item.status === STATUS.RUNNING) Object.assign(item, { status: STATUS.QUEUED, interrupted: false });
    }
    await this.store.saveQueue(queue);
    this.changed();
  }

  async run() {
    const settings = await this.store.getSettings();
    this.settings = settings;
    this.assets = await this.store.getAssets();
    this.previousImage = await this.store.getLastImage();
    const queue = await this.store.getQueue();
    this.promptCount = new Set(queue.map((i) => i.index)).size;
    let n = Math.min(6, Math.max(1, Math.round(Number(settings.concurrency)) || 1));
    const queued = queue.filter((i) => i.status === STATUS.QUEUED);
    if (!queued.length) return;
    if (n > 1 && queued.some((i) => i.chatMode === 'concat' || i.imageMode === 'last')) {
      n = 1;
      this.log('info', 'logSequential');
    }
    n = Math.min(n, queued.length);
    const tabIds = await this.pickTabs(n);
    this.workers = tabIds.map((tabId, k) => ({ k, tabId, item: null, prev: null, status: '', mode: '', chatUrl: '', reload: false, modelApplied: '' }));
    this.solo = n === 1;
    await Promise.all(this.workers.map((w) => this.work(w)));
  }

  /** The chatgpt.com tabs to use: open ones first (the one in front first), then new ones. */
  async pickTabs(n) {
    const all = await api.tabs.query({ url: CHAT_HOSTS.map((h) => `${h}*`) }).catch(() => []);
    const [front] = await api.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
    all.sort((a, b) => (b.id === front?.id) - (a.id === front?.id) || (b.active - a.active));
    const ids = all.slice(0, n).map((t) => t.id);
    let opened = 0;
    while (ids.length < n) {
      const tab = await api.tabs.create({ url: CHAT_URL, active: ids.length === 0 });
      ids.push(tab.id);
      opened++;
    }
    if (opened) this.log('info', 'logOpenedTabs', [opened]);
    return ids;
  }

  /** Take the next queued item (marks it running). */
  async claim() {
    const queue = await this.store.getQueue();
    const item = queue.find((i) => i.status === STATUS.QUEUED);
    if (!item) return null;
    Object.assign(item, { status: STATUS.RUNNING, error: '', startedAt: Date.now() });
    await this.store.saveQueue(queue);
    this.changed();
    return item;
  }

  async work(w) {
    while (!this.stopRequested) {
      const item = await this.claim();
      if (!item) break;
      w.item = item;
      w.status = 'starting';
      w.mode = '';
      this.log('info', 'logRunning', [itemLabel(item)]);
      const t0 = Date.now();
      let result;
      try {
        result = await this.runItem(w, item);
      } catch (e) {
        result = { ok: false, error: String(e?.message || e), stage: 'send' };
      }
      w.item = null;
      if (this.stopRequested) break;
      await this.record(w, item, result, t0);
      const more = (await this.store.getQueue()).some((i) => i.status === STATUS.QUEUED);
      if (more && !this.stopRequested) await this.delay(randomDelay(this.settings.minDelay, this.settings.maxDelay));
    }
  }

  async runItem(w, item) {
    const s = this.settings;
    const request = buildRequest(item, s, this.assets, { previousImage: this.previousImage, promptCount: this.promptCount });
    const resume = !!item.interrupted;
    const model = (expectsImages(item.mode) ? s.imageModel : s.textModel) || '';
    let target = null;
    let newChat = false;
    if (resume && conversationId(item.chatUrl)) target = item.chatUrl;
    else if (!resume) {
      if (!startsNewChat(w.prev) && conversationId(w.chatUrl)) target = w.chatUrl;
      else newChat = true;
    }
    if (newChat) w.chatUrl = ''; // learned again from the page once ChatGPT assigns the new chat an id
    await this.prepareTab(w, { target, newChat, model, reload: w.reload && !newChat });
    w.reload = false;
    await this.keepAwake(w.tabId);
    return this.follow(w, item, {
      ...request,
      resume,
      timeoutMs: Math.max(1, Number(s.timeoutMinutes) || 10) * 60000,
    });
  }

  /** Hand the prompt to the tab and poll until the reply is done. */
  async follow(w, item, payload) {
    const id = crypto.randomUUID();
    const label = itemLabel(item);
    const res = await api.tabs.sendMessage(w.tabId, { type: 'CGA_SUBMIT', job: { id, ...payload } }).catch((e) => ({ ok: false, error: String(e?.message || e) }));
    if (!res?.ok) return { ok: false, error: res?.error || 'The ChatGPT tab did not answer', stage: 'send' };
    // The chat's address, as soon as ChatGPT gives the new chat one: if the tab goes away
    // mid-reply, the next attempt returns there and collects the reply instead of resending.
    const onUrl = (tabId, info) => {
      if (tabId === w.tabId && info.url && !conversationId(w.chatUrl) && conversationId(info.url)) w.chatUrl = info.url;
    };
    api.tabs.onUpdated.addListener(onUrl);
    try {
      return await this.poll(w, id, label, payload);
    } finally {
      api.tabs.onUpdated.removeListener(onUrl);
    }
  }

  async poll(w, id, label, payload) {
    const hardDeadline = Date.now() + payload.timeoutMs + 3 * 60000;
    let notesSeen = 0;
    let lost = 0;
    let nextCheck = Date.now() + PAGE_CHECK_MS;
    w.status = 'typing';
    for (;;) {
      await this.sleep(POLL_MS);
      if (this.stopRequested) return { ok: false, stopped: true };
      if (w.fixRequested) {
        w.fixRequested = false;
        return { ok: false, fixed: true, error: 'Fix Error' };
      }
      const r = await api.tabs.sendMessage(w.tabId, { type: 'CGA_POLL', id }).catch((e) => ({ transport: String(e?.message || e) }));
      if (!r || r.transport || r.state === 'lost') {
        // Reloaded, navigated to another site, or closed. A second miss in a row settles it.
        if (++lost < 2 && r?.state !== 'lost') continue;
        return { ok: false, interrupted: true, error: 'The ChatGPT page was reloaded or closed while the prompt was running', url: w.chatUrl };
      }
      lost = 0;
      if (conversationId(r.url) && !conversationId(w.chatUrl)) w.chatUrl = r.url;
      if (conversationId(w.chatUrl) && w.item && w.item.chatUrl !== w.chatUrl) {
        // Saved right away, so a panel closed mid-reply still knows where to collect it.
        w.item.chatUrl = w.chatUrl;
        await this.store.saveQueue(await this.store.getQueue());
        this.changed();
      }
      if (r.visibility === 'hidden' && this.solo && !this.hiddenWarned) {
        this.hiddenWarned = true;
        this.log('warn', 'logTabHidden');
      }
      if (r.status !== w.status) {
        if (r.status === 'sent') this.log('info', 'logSent', [label]);
        if (r.status === 'image') this.log('info', 'logWaitingForImage', [label]);
        if (r.status === 'nudged') this.log('info', 'logNudged', [label]);
        w.status = r.status;
        this.changed();
      }
      if (r.mode !== w.mode) {
        w.mode = r.mode;
        this.changed();
      }
      for (const text of (r.notes || []).slice(notesSeen)) this.log('info', 'logNote', [label, text]);
      notesSeen = (r.notes || []).length;
      if (r.state === 'done') return { ok: true, text: r.text, images: r.images || [], url: r.url, resumed: r.resumed, mode: r.mode };
      if (r.state === 'refused') return { ok: false, refused: true, error: r.error, text: r.text, url: r.url };
      if (r.state === 'error') return { ok: false, error: r.error, stage: r.stage, url: conversationId(r.url) ? r.url : w.chatUrl };
      if (Date.now() > hardDeadline) return { ok: false, error: 'Timed out waiting for the reply', stage: 'reply', url: w.chatUrl };
      if (Date.now() >= nextCheck) {
        nextCheck = Date.now() + PAGE_CHECK_MS;
        this.logPageCheck(w, label);
      }
    }
  }

  async logPageCheck(w, label) {
    const d = await this.diagnostics(w.tabId);
    if (!d || d.error) return;
    const s = d.streams?.[d.streams.length - 1];
    const a = d.job?.analysis;
    const parts = [
      `job ${d.job?.phase || '-'}/${d.job?.status || '-'} (${d.job?.mode || '-'})`,
      `hook ${d.hook ? '✓' : '✗'}`,
      `stream ${s ? `${s.open ? 'open' : `closed ${s.status}`} ${s.secs}s${s.imageTask ? ' image' : ''}` : '-'}`,
      `reply ${a ? `${a.anchor ? '' : 'prompt not found '}${a.final ? 'final' : `waiting (${a.lastRole || '-'} ${a.lastStatus || ''})`} ${a.chars || 0} chars ${a.images || 0} img` : '-'}`,
      `tab ${d.visibility}`,
    ];
    this.log('info', 'logPageCheck', [label, parts.join(' · ')]);
  }

  async record(w, item, result, t0) {
    const queue = await this.store.getQueue();
    const current = queue.find((i) => i.id === item.id);
    if (!current) return; // removed while running
    const label = itemLabel(current);
    current.interrupted = false;
    if (result.url && conversationId(result.url)) current.chatUrl = result.url;
    if (result.ok) {
      Object.assign(current, {
        status: STATUS.COMPLETED,
        finishedAt: Date.now(),
        output: (result.text || '').slice(0, 20000),
        imageCount: (result.images || []).length,
        error: '',
      });
      w.prev = current;
      if (result.images?.length && expectsImages(current.mode)) {
        const dataUrl = await asDataUrl(result.images[result.images.length - 1]);
        if (dataUrl) {
          this.previousImage = { name: `last-image-${current.index + 1}.png`, dataUrl };
          await this.store.setLastImage(this.previousImage);
        }
      }
      await this.store.saveQueue(queue);
      this.changed();
      if (result.resumed) this.log('info', 'logResumed', [label]);
      this.log('success', 'logCompleted', [label, secs(Date.now() - t0), result.mode === 'page' ? 'page' : 'network']);
      await this.download(current, result);
      return;
    }
    w.prev = null;
    if (result.fixed) {
      Object.assign(current, { status: STATUS.QUEUED, error: '' });
      w.reload = true;
      await this.store.saveQueue(queue);
      this.changed();
      this.log('info', 'logFixed', [label]);
      return;
    }
    if (result.refused) {
      current.refusals = (current.refusals || 0) + 1;
      current.error = result.error;
      const skip = current.refusals > REFUSAL_RETRIES;
      current.status = skip ? STATUS.REFUSED : STATUS.QUEUED;
      await this.store.saveQueue(queue);
      this.changed();
      this.log('warn', skip ? 'logRefusedSkip' : 'logRefused', [label]);
      return;
    }
    current.error = result.error || 'Unknown error';
    await this.logDiagnostics(w.tabId);
    // Interrupted (page reloaded or closed, reply still running at the time limit): the prompt may
    // already be in the chat, so the next attempt follows its reply instead of resending. These
    // have their own allowance so they don't use up the prompt's retries.
    current.interrupted = wasInterrupted(result);
    if (current.interrupted && (current.interruptions || 0) < MAX_INTERRUPTIONS) current.interruptions = (current.interruptions || 0) + 1;
    else current.retries = (current.retries || 0) + 1;
    const max = Math.max(0, Number(this.settings.maxRetries) || 0);
    current.status = (current.retries || 0) > max ? STATUS.FAILED : STATUS.QUEUED;
    if (current.status === STATUS.FAILED) current.interrupted = false;
    await this.store.saveQueue(queue);
    this.changed();
    const failed = current.status === STATUS.FAILED;
    if (failed) this.log('error', 'logFailed', [label, current.error, current.retries || 0, max]);
    else if (current.interrupted) this.log('warn', 'logInterrupted', [label, current.error]);
    else this.log('warn', 'logRetrying', [label, current.error, current.retries || 0, max]);
    // A failed reply often leaves the page in a bad state: start the next attempt from a fresh page.
    w.reload = true;
  }

  async logDiagnostics(tabId) {
    const d = await this.diagnostics(tabId);
    if (!d || d.error) return;
    const yes = (v) => (v ? '✓' : '✗');
    const s = d.streams?.[d.streams.length - 1];
    this.log('info', 'logDiagnostics', [[
      `hook ${yes(d.hook)}`, `composer ${yes(d.composer)}`, `send ${yes(d.send)}`, `stop ${yes(d.stop)}`, `turns ${d.turns}`,
      `last stream ${s ? `${s.path} ${s.open ? 'open' : s.status} ${(s.types || []).slice(0, 6).join(',')}` : '-'}`,
      `tab ${d.visibility}`,
    ].join(' · ')]);
  }

  /** The content script's view of a ChatGPT tab (null when none answers). */
  async diagnostics(tabId = null) {
    if (tabId == null) {
      const all = await api.tabs.query({ url: CHAT_HOSTS.map((h) => `${h}*`) }).catch(() => []);
      tabId = all.find((t) => t.active)?.id ?? all[0]?.id;
    }
    if (tabId == null) return null;
    const res = await api.tabs.sendMessage(tabId, { type: 'CGA_DIAGNOSE' }).catch(() => null);
    return res?.diagnostics || null;
  }

  /**
   * Get the worker's tab ready on the right chat.
   * target:  a conversation URL to be on (navigates there if the tab is elsewhere)
   * newChat: an empty chat (ChatGPT's own "New chat", or a page load to apply a model)
   * reload:  reload the page first
   */
  async prepareTab(w, { target = null, newChat = false, model = '', reload = false }) {
    let tab = await api.tabs.get(w.tabId).catch(() => null);
    let freshAfter = 0;
    if (!tab || !isChatUrl(tab.url)) {
      freshAfter = Date.now();
      if (target) this.log('info', 'logReturningToChat');
      if (tab) await navigate(tab.id, target || CHAT_URL);
      else {
        tab = await api.tabs.create({ url: target || CHAT_URL, active: w.k === 0 });
        w.tabId = tab.id;
      }
    } else if (target && conversationId(tab.url) !== conversationId(target)) {
      this.log('info', 'logReturningToChat');
      freshAfter = await navigate(tab.id, target);
    } else if (newChat) {
      if (model && w.modelApplied !== model) {
        // ?model= picks the model for the new chat; ChatGPT keeps it for the following new chats.
        freshAfter = await navigate(tab.id, `${CHAT_URL}?model=${encodeURIComponent(model)}`);
        w.modelApplied = model;
      } else if (reload || !(await this.softNewChat(tab.id))) {
        freshAfter = await navigate(tab.id, CHAT_URL);
      }
    } else if (reload) {
      freshAfter = Date.now();
      const started = waitForNavigation(tab.id);
      await api.tabs.reload(tab.id);
      await started;
    }
    await this.ensureDriver(w.tabId, { freshAfter });
  }

  async softNewChat(tabId) {
    try {
      await this.ensureDriver(tabId);
      const res = await api.tabs.sendMessage(tabId, { type: 'CGA_NEW_CHAT' });
      return !!res?.ok;
    } catch {
      return false;
    }
  }

  /** Wait until the tab's content script answers and the prompt box exists; inject it if needed. */
  async ensureDriver(tabId, { freshAfter = 0 } = {}) {
    const end = Date.now() + 45000;
    let lastInjection = 0;
    let hookInjected = false;
    while (Date.now() < end) {
      const res = await api.tabs.sendMessage(tabId, { type: 'CGA_PING' }).catch(() => null);
      const fresh = !freshAfter || (res?.loadedAt || 0) >= freshAfter - 500;
      if (res?.ok && fresh) {
        if (!res.hook && !hookInjected) {
          // Tab opened before the extension was installed or updated: add the page hook now.
          hookInjected = true;
          await api.scripting.executeScript({ target: { tabId }, files: CONTENT_MAIN, world: 'MAIN' }).catch(() => {});
        }
        if (res.ready) return res;
      }
      if (!res && Date.now() - lastInjection > 3000) {
        lastInjection = Date.now();
        await api.scripting.executeScript({ target: { tabId }, files: CONTENT_MAIN, world: 'MAIN' }).catch(() => {});
        await api.scripting.executeScript({ target: { tabId }, files: CONTENT_ISOLATED }).catch(() => {});
      }
      await sleep(300);
    }
    throw new Error('ChatGPT page is not ready (are you logged in?)');
  }

  /** Keep the tab working: no discarding, and in front of its window when running one at a time. */
  async keepAwake(tabId) {
    if (!this.discardGuarded.has(tabId)) {
      const ok = await api.tabs.update(tabId, { autoDiscardable: false }).then(() => true, () => false);
      if (ok) this.discardGuarded.add(tabId);
    }
    if (!this.solo || this.settings.keepTabActive === false) return;
    const tab = await api.tabs.get(tabId).catch(() => null);
    if (tab && !tab.active) {
      await api.tabs.update(tabId, { active: true }).catch(() => {});
      this.log('info', 'logTabActivated');
    }
  }

  /** Sleep that Stop and Fix Error cut short. */
  sleep(ms) {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.wakers.delete(done);
        resolve();
      };
      const t = setTimeout(done, ms);
      this.wakers.add(done);
    });
  }

  async delay(ms) {
    this.waitUntil = Math.max(this.waitUntil || 0, Date.now() + ms);
    this.changed();
    await this.sleep(ms);
    if (Date.now() >= this.waitUntil) this.waitUntil = 0;
    this.changed();
  }

  async download(item, result) {
    const s = this.settings;
    const common = { folder: s.folder, index: item.index, prompt: item.prompt, rename: s.renameFiles !== false, copy: item.copy };
    const jobs = [];
    const images = result.images || [];
    if (s.imageDownload !== 'none') {
      images.forEach((image, k) => {
        const part = images.length > 1 ? k : null;
        if (/^https?:/i.test(image)) {
          jobs.push({ url: image, filename: buildFilename({ ...common, ext: extFromUrl(image), part }) });
          return;
        }
        const ext = extFromMime(mimeFromDataUrl(image));
        jobs.push({ blob: () => dataUrlToBlob(image), filename: buildFilename({ ...common, ext: ext === 'bin' ? 'png' : ext, part }) });
      });
    }
    const textMode = item.mode === MODES.TEXT || item.mode === MODES.INGREDIENTS;
    if (textMode && result.text && s.textDownload && s.textDownload !== 'none') {
      const md = s.textDownload !== 'txt';
      const body = md ? `# Prompt\n\n${item.prompt}\n\n# Response\n\n${result.text}\n` : `${result.text}\n`;
      jobs.push({ blob: () => new Blob([body], { type: md ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8' }), filename: buildFilename({ ...common, ext: md ? 'md' : 'txt' }) });
    }
    for (const job of jobs) await this.save(job.blob || job.url, job.filename);
  }

  /** Save through the downloads API, from a blob: URL or straight from an http(s) URL. */
  async save(source, filename) {
    let objectUrl = '';
    try {
      const url = typeof source === 'string' ? source : (objectUrl = URL.createObjectURL(await source()));
      await api.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });
      this.log('info', 'logDownloaded', [filename]);
    } catch (e) {
      this.log('error', 'logDownloadFailed', [filename, String(e?.message || e)]);
    } finally {
      if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 120000);
    }
  }
}

/** Run fn while holding the single-engine lock. Resolves false (without running) if it's taken. */
async function withLock(fn) {
  const locks = globalThis.navigator?.locks;
  if (!locks) {
    await fn();
    return true;
  }
  return locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
    if (!lock) return false;
    await fn();
    return true;
  });
}

/** Image extension from a URL's path, png when it doesn't say. */
export function extFromUrl(url) {
  try {
    const m = /\.(png|jpe?g|webp|gif)$/i.exec(new URL(url).pathname);
    if (m) return m[1].toLowerCase().replace('jpeg', 'jpg');
  } catch { /* not a URL */ }
  return 'png';
}

/** A data: URL as is; an http(s) image fetched into one (null if the panel can't read it). */
async function asDataUrl(image) {
  if (!/^https?:/i.test(image)) return image;
  try {
    const blob = await (await fetch(image, { credentials: 'include' })).blob();
    return await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

async function dataUrlToBlob(dataUrl) {
  return (await fetch(dataUrl)).blob();
}

/** Start loading url in the tab; resolves once loading has begun. Returns the navigation start time. */
async function navigate(tabId, url) {
  const startedAt = Date.now();
  const started = waitForNavigation(tabId);
  await api.tabs.update(tabId, { url });
  await started;
  return startedAt;
}

const secs = (ms) => (Math.max(0, ms) / 1000).toFixed(1);

/** Resolve as soon as the tab starts loading a new page (or after 5 s). Attach before navigating. */
function waitForNavigation(tabId, timeout = 5000) {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, timeout);
    function finish() {
      clearTimeout(timer);
      api.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    function listener(id, info) {
      if (id === tabId && (info.status === 'loading' || info.url)) finish();
    }
    api.tabs.onUpdated.addListener(listener);
  });
}
