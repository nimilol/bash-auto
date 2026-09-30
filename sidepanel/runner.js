// Queue engine. Lives in the side panel page, which stays alive while the panel is open.
import { STATUS, buildFilename, extFromMime, mimeFromDataUrl, randomDelay } from '../lib/utils.js';
import { buildRequest, wantsNewChat, MODES } from './modes.js';

const CHAT_URL = 'https://chatgpt.com/';
const CHAT_HOSTS = ['https://chatgpt.com/', 'https://chat.openai.com/'];
const isChatUrl = (url) => CHAT_HOSTS.some((h) => String(url || '').startsWith(h));

/** "/c/<id>" conversation id (also inside project/GPT paths), or null for a blank chat. */
export function conversationId(url) {
  const m = /\/c\/([\w-]+)/.exec(String(url || ''));
  return m ? m[1] : null;
}

// Errors where the prompt may already be in the chat (tab closed/reloaded, reply still running).
const TRANSPORT_ERROR = /no response|receiving end|message port|message channel|not ready|timed out waiting for the reply|tab was closed|no tab with id/i;
const REFUSAL_PAUSE_MS = 2000;
const MAX_INTERRUPTIONS = 5; // per prompt, on top of the normal retries

export class Runner {
  /**
   * @param store  { getQueue, saveQueue, getSettings, getAssets, getLastImage, setLastImage, getSession, setSession }
   * @param hooks  { onChange(), onLog(kind, key, params) }
   */
  constructor(store, hooks) {
    this.store = store;
    this.hooks = hooks;
    this.state = 'idle'; // idle | running | pausing | waiting
    this.tabId = null;
    this.stopRequested = false;
    this.pauseRequested = false;
    this.wakeDelay = null;
    this.waitUntil = 0;
    this.settings = null;
    // The driver reports the conversation URL mid-reply (see reportConversation in driver.js).
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === 'CGA_CHAT_URL' && this.busy && this.settings?.singleChat && conversationId(msg.url)) {
        this.rememberChat(msg.url);
      }
    });
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

  async start() {
    if (this.busy) return;
    this.stopRequested = false;
    this.pauseRequested = false;
    this.state = 'running';
    this.changed();
    this.log('info', 'logStarted');
    try {
      await this.loop();
    } catch (e) {
      this.log('error', 'logFatal', [String(e.message || e)]);
    } finally {
      const halted = this.stopRequested || this.pauseRequested;
      this.state = 'idle';
      this.waitUntil = 0;
      this.changed();
      if (!halted) this.log('success', 'logFinished');
    }
  }

  pause() {
    if (!this.busy) return;
    this.pauseRequested = true;
    this.state = 'pausing';
    this.log('info', 'logPausing');
    this.wakeDelay?.();
    this.changed();
  }

  async stop() {
    if (!this.busy) return;
    this.stopRequested = true;
    this.wakeDelay?.();
    if (this.tabId != null) chrome.tabs.sendMessage(this.tabId, { type: 'CGA_STOP' }).catch(() => {});
    const queue = await this.store.getQueue();
    for (const item of queue) {
      if (item.status === STATUS.RUNNING) Object.assign(item, { status: STATUS.QUEUED, interrupted: true });
    }
    await this.store.saveQueue(queue);
    this.log('info', 'logStopped');
    this.changed();
  }

  async loop() {
    const settings = await this.store.getSettings();
    this.settings = settings;
    const assets = await this.store.getAssets();
    let previousImage = settings.chain ? await this.store.getLastImage() : null;
    let firstInRun = true;
    let reloadChat = false; // after an error, reload the chat before the next attempt
    const combined = [];

    while (!this.stopRequested && !this.pauseRequested) {
      const queue = await this.store.getQueue();
      const item = queue.find((i) => i.status === STATUS.QUEUED);
      if (!item) break;

      const resume = !!item.interrupted;
      item.status = STATUS.RUNNING;
      item.error = '';
      item.startedAt = Date.now();
      await this.store.saveQueue(queue);
      this.changed();
      this.log('info', 'logRunning', [item.index + 1]);

      let result;
      try {
        const request = buildRequest(item, { ...settings, queueLength: queue.length }, assets, { previousImage });
        const tabId = await this.openChat(settings, firstInRun, reloadChat);
        firstInRun = false;
        reloadChat = false;
        result = await this.send(tabId, {
          ...request,
          resumeIfSent: resume,
          timeoutMs: Math.max(1, Number(settings.timeoutMinutes) || 10) * 60000,
        });
      } catch (e) {
        result = { ok: false, error: String(e.message || e) };
      }
      if (this.stopRequested) break;

      const fresh = await this.store.getQueue();
      const current = fresh.find((i) => i.id === item.id);
      if (!current) continue; // removed while running
      current.interrupted = false;

      // Remember the conversation this run lives in, so interruptions can return to it.
      if (settings.singleChat && conversationId(result.url)) await this.rememberChat(result.url);

      if (result.ok) {
        current.status = STATUS.COMPLETED;
        current.finishedAt = Date.now();
        current.output = (result.text || '').slice(0, 20000);
        current.imageCount = (result.images || []).length;
        current.chatUrl = result.url || '';
        if (result.images?.length) {
          previousImage = { name: `chain-${current.index + 1}.png`, dataUrl: result.images[result.images.length - 1] };
          if (settings.chain) await this.store.setLastImage(previousImage);
        }
        combined.push(current);
        await this.store.saveQueue(fresh);
        this.changed();
        if (result.resumed) this.log('info', 'logResumed', [current.index + 1]);
        this.log('success', 'logCompleted', [current.index + 1]);
        if (settings.autoDownload) await this.download(current, result, settings);
      } else if (result.refused) {
        // Policy refusal: retry a limited number of times, then skip straight to the next prompt.
        current.refusals = (current.refusals || 0) + 1;
        current.error = result.error;
        current.chatUrl = result.url || current.chatUrl || '';
        const limit = Math.max(0, Number(settings.refusalRetries) || 0);
        const skip = current.refusals > limit;
        current.status = skip ? STATUS.REFUSED : STATUS.QUEUED;
        await this.store.saveQueue(fresh);
        this.changed();
        this.log('warn', skip ? 'logRefusedSkip' : 'logRefused', [current.index + 1, current.refusals, limit]);
        if (!this.stopRequested && !this.pauseRequested) await this.delay(REFUSAL_PAUSE_MS);
        continue;
      } else {
        current.error = result.error || 'Unknown error';
        // Interrupted (tab closed/reloaded/moved, panel issue): the prompt may already be in the chat,
        // so the next attempt collects its reply rather than resending. These get their own allowance
        // so an interruption doesn't use up the prompt's normal retries.
        current.interrupted = TRANSPORT_ERROR.test(current.error);
        if (current.interrupted && (current.interruptions || 0) < MAX_INTERRUPTIONS) {
          current.interruptions = (current.interruptions || 0) + 1;
        } else {
          current.retries = (current.retries || 0) + 1;
        }
        const maxRetries = Math.max(0, Number(settings.maxRetries) || 0);
        current.status = (current.retries || 0) > maxRetries ? STATUS.FAILED : STATUS.QUEUED;
        await this.store.saveQueue(fresh);
        this.changed();
        this.log(current.status === STATUS.FAILED ? 'error' : 'warn',
          current.status === STATUS.FAILED ? 'logFailed' : 'logRetrying',
          [current.index + 1, current.error, current.retries || 0, maxRetries]);
        // A failed reply often leaves the page in a bad state. Reload it: the session chat in
        // single-chat mode, the same thread in concat mode, otherwise a fresh chat.
        reloadChat = true;
      }

      const remaining = (await this.store.getQueue()).some((i) => i.status === STATUS.QUEUED);
      if (remaining && !this.stopRequested && !this.pauseRequested) {
        await this.delay(randomDelay(settings.minDelay, settings.maxDelay));
      }
    }

    if (settings.mode === MODES.TEXT && settings.concat && settings.autoDownload && combined.length > 1 && !this.stopRequested) {
      await this.downloadCombined(combined, settings);
    }
  }

  async rememberChat(url) {
    const session = await this.store.getSession();
    if (conversationId(session?.chatUrl) === conversationId(url)) return;
    await this.store.setSession({ chatUrl: url, startedAt: Date.now() });
    this.changed();
  }

  /** Get a ready ChatGPT tab on the right conversation for the next prompt. */
  async openChat(settings, firstInRun, reloadChat) {
    const session = settings.singleChat ? await this.store.getSession() : null;
    if (session?.chatUrl) {
      try {
        return await this.prepareTab({ target: session.chatUrl, reload: reloadChat });
      } catch (e) {
        if (!e.sessionLost) throw e;
        await this.store.setSession(null);
        this.changed();
        this.log('warn', 'logSessionLost');
        return this.prepareTab({ newChat: true });
      }
    }
    const concatThread = settings.mode === MODES.TEXT && settings.concat && !firstInRun;
    const newChat = wantsNewChat(settings, firstInRun, false) || (reloadChat && !concatThread);
    return this.prepareTab({ newChat, reload: reloadChat && concatThread });
  }

  /**
   * Find (or open) a chatgpt.com tab.
   * target:  a conversation URL the tab must be on (navigates back to it if the tab moved away)
   * newChat: load a blank conversation
   * reload:  reload the current page first
   */
  async prepareTab({ target = null, newChat = false, reload = false } = {}) {
    const targetId = conversationId(target);
    let tab = null;
    if (this.tabId != null) tab = await chrome.tabs.get(this.tabId).catch(() => null);
    if (!tab || !isChatUrl(tab.url)) tab = null;
    if (targetId && (!tab || conversationId(tab.url) !== targetId)) {
      const all = await chrome.tabs.query({ url: CHAT_HOSTS.map((h) => `${h}*`) });
      tab = all.find((t) => conversationId(t.url) === targetId) || tab;
    }
    if (!tab) {
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (active && isChatUrl(active.url)) tab = active;
      else {
        const all = await chrome.tabs.query({ url: CHAT_HOSTS.map((h) => `${h}*`) });
        tab = all[0] || null;
      }
    }

    const url = target || CHAT_URL;
    if (!tab) {
      tab = await chrome.tabs.create({ url, active: true });
      await waitForTabLoad(tab.id);
    } else if (targetId && conversationId(tab.url) !== targetId) {
      this.log('info', 'logReturningToChat');
      await navigate(tab.id, url);
    } else if (newChat) {
      await navigate(tab.id, CHAT_URL);
    } else if (reload) {
      const loaded = waitForTabLoad(tab.id, { expectNavigation: true });
      await chrome.tabs.reload(tab.id);
      await loaded;
    }
    this.tabId = tab.id;
    const page = await this.ensureDriver(tab.id);
    if (targetId && (page.missing || conversationId(page.url) !== targetId)) {
      const err = new Error('The session chat could not be opened');
      err.sessionLost = true;
      throw err;
    }
    return tab.id;
  }

  delay(ms) {
    this.state = 'waiting';
    this.waitUntil = Date.now() + ms;
    this.changed();
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      const self = this;
      function done() {
        clearTimeout(t);
        self.wakeDelay = null;
        self.waitUntil = 0;
        if (self.state === 'waiting') self.state = 'running';
        self.changed();
        resolve();
      }
      this.wakeDelay = done;
    });
  }

  async ensureDriver(tabId) {
    const end = Date.now() + 30000;
    let lastInjection = 0;
    while (Date.now() < end) {
      const res = await chrome.tabs.sendMessage(tabId, { type: 'CGA_PING' }).catch(() => null);
      if (res?.ok && res.ready) return res;
      // No listener: the declarative content script didn't run (tab opened before install,
      // or injection raced navigation). Inject it ourselves; the driver guards against doubles.
      if (!res && Date.now() - lastInjection > 3000) {
        lastInjection = Date.now();
        await chrome.scripting
          .executeScript({ target: { tabId }, files: ['content/selectors.js', 'content/driver.js'] })
          .catch(() => {});
      }
      await new Promise((r) => setTimeout(r, 700));
    }
    throw new Error('ChatGPT page is not ready (are you logged in?)');
  }

  async send(tabId, payload) {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'CGA_RUN', payload });
    return res || { ok: false, error: 'No response from the ChatGPT tab (page reloaded?)' };
  }

  async download(item, result, settings) {
    const common = { project: settings.project, index: item.index, prompt: item.prompt, renameByPrompt: settings.renameByPrompt };
    const jobs = [];
    const images = result.images || [];
    images.forEach((dataUrl, k) => {
      const ext = extFromMime(mimeFromDataUrl(dataUrl));
      jobs.push({ url: dataUrl, filename: buildFilename({ ...common, ext: ext === 'bin' ? 'png' : ext, part: images.length > 1 ? k : null }) });
    });
    const wantText = settings.mode === MODES.TEXT || settings.mode === MODES.INGREDIENTS || (settings.saveTextWithImages && result.text);
    if (wantText && result.text) {
      const body = `# Prompt\n\n${item.prompt}\n\n# Response\n\n${result.text}\n`;
      jobs.push({ url: textDataUrl(body), filename: buildFilename({ ...common, ext: 'md' }) });
    }
    for (const job of jobs) {
      try {
        await chrome.downloads.download({ url: job.url, filename: job.filename, conflictAction: 'uniquify', saveAs: false });
        this.log('info', 'logDownloaded', [job.filename]);
      } catch (e) {
        this.log('error', 'logDownloadFailed', [job.filename, String(e.message || e)]);
      }
    }
  }

  async downloadCombined(items, settings) {
    const body = items
      .sort((a, b) => a.index - b.index)
      .map((i) => `## ${i.index + 1}. ${i.prompt}\n\n${i.output}\n`)
      .join('\n---\n\n');
    const filename = buildFilename({ project: settings.project, index: -1, prompt: 'concat-combined', ext: 'md', renameByPrompt: true })
      .replace('/000-', '/');
    await chrome.downloads
      .download({ url: textDataUrl(body), filename, conflictAction: 'uniquify', saveAs: false })
      .then(() => this.log('info', 'logDownloaded', [filename]))
      .catch((e) => this.log('error', 'logDownloadFailed', [filename, String(e.message || e)]));
  }
}

async function navigate(tabId, url) {
  const loaded = waitForTabLoad(tabId, { expectNavigation: true });
  await chrome.tabs.update(tabId, { url, active: true });
  await loaded;
}

function textDataUrl(text) {
  return `data:text/markdown;charset=utf-8,${encodeURIComponent(text)}`;
}

/** Resolve once the tab finishes loading. Attach before navigating when expectNavigation is set. */
function waitForTabLoad(tabId, { timeout = 45000, expectNavigation = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(finish, timeout);
    function finish() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      // ChatGPT hydrates after "complete"; give it a moment.
      setTimeout(resolve, 1500);
    }
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') finish();
    }
    chrome.tabs.onUpdated.addListener(listener);
    if (!expectNavigation) {
      chrome.tabs.get(tabId).then((t) => t.status === 'complete' && finish()).catch(finish);
    }
  });
}
