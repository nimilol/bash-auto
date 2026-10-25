// Service worker: owns the run. The panel sends commands here; the engine does the work and saves
// its state, which the panel reads from storage. A watchdog alarm restarts the engine if the
// browser stopped the worker in the middle of a run.
import { Engine } from './engine.js';
import { createStore } from './store.js';
import { saveOutputs } from './downloads.js';
import { CHAT_ORIGINS, STATUS, makeItems, normalizeSettings, expectsImages } from '../lib/utils.js';

const CHAT_PATTERNS = CHAT_ORIGINS.map((o) => `${o}/*`);
const MAIN_SCRIPTS = ['content/sse.js', 'content/page-hook.js'];
const ISOLATED_SCRIPTS = ['content/dom.js', 'content/conversation.js', 'content/decide.js', 'content/agent.js'];
const WATCHDOG = 'cga-watchdog';
const ACTIVE_STATES = ['running', 'waitingNetwork', 'waitingLogin'];

const store = createStore(chrome.storage.local);

/** Resolves once the tab starts loading a new page (or after 5 s). */
function waitForLoading(tabId, timeout = 5000) {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, timeout);
    function finish() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    function listener(id, info) {
      if (id === tabId && (info.status === 'loading' || info.url)) finish();
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

const browser = {
  getTab: (id) => chrome.tabs.get(id).catch(() => null),
  findChatTabs: async () => {
    const tabs = await chrome.tabs.query({ url: CHAT_PATTERNS }).catch(() => []);
    const [front] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
    return tabs.sort((a, b) => (b.id === front?.id) - (a.id === front?.id) || b.active - a.active);
  },
  createTab: (url, active) => chrome.tabs.create({ url, active }),
  async navigate(tabId, url) {
    const started = waitForLoading(tabId);
    const tab = await chrome.tabs.update(tabId, { url });
    await started;
    return tab;
  },
  reload: (tabId) => chrome.tabs.reload(tabId),
  send: (tabId, msg) => chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }),
  async inject(tabId, which) {
    await chrome.scripting.executeScript({ target: { tabId }, files: MAIN_SCRIPTS, world: 'MAIN' });
    if (which === 'all') await chrome.scripting.executeScript({ target: { tabId }, files: ISOLATED_SCRIPTS });
  },
  async keepAlive(tabId) {
    chrome.runtime.getPlatformInfo().catch(() => {}); // any extension call keeps the worker running
    if (tabId != null) await chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
  },
  activate: async (tabId) => {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab && !tab.active) await chrome.tabs.update(tabId, { active: true });
  },
};

const engine = new Engine({
  store,
  browser,
  save: (item, result, settings) => saveOutputs(item, result, settings, (kind, text) => store.log(kind, text)),
  onChange: () => {},
});

async function startWatchdog() {
  await chrome.alarms.create(WATCHDOG, { periodInMinutes: 0.5 });
}

async function run() {
  await startWatchdog();
  return engine.start();
}

/** After the worker was stopped mid-run: carry on. */
async function revive() {
  await store.load();
  const state = store.run.state;
  if (engine.busy) return;
  if (ACTIVE_STATES.includes(state)) {
    await startWatchdog();
    await engine.start({ restart: true });
  } else if (state === 'stopping') {
    await store.setRun({ state: 'idle' });
  } else if (state === 'idle') {
    chrome.alarms.clear(WATCHDOG).catch(() => {});
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WATCHDOG) revive();
});

function setupPanel() {
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}
chrome.runtime.onInstalled.addListener(setupPanel);
chrome.runtime.onStartup.addListener(() => {
  setupPanel();
  revive();
});
setupPanel();
setTimeout(revive, 500);

// ---- Commands from the panel -------------------------------------------------------------------

const COMMANDS = {
  async state() {
    return { run: store.run, busy: engine.busy };
  },
  async run() {
    const started = await run();
    return { started };
  },
  async stop() {
    await engine.stop();
    return {};
  },
  async recover() {
    await engine.recover();
    return {};
  },
  async newChat() {
    await startWatchdog();
    await engine.newChat();
    return {};
  },
  async addPrompts({ prompts, mode }) {
    const settings = normalizeSettings((await chrome.storage.local.get('settings')).settings);
    const m = mode || settings.mode;
    const items = makeItems(prompts || [], {
      mode: m,
      firstIndex: store.queue.reduce((max, i) => Math.max(max, i.index + 1), 0),
      outputs: expectsImages(m) ? settings.imageOutputs : settings.textOutputs,
      imageMode: settings.imageMode,
    });
    store.queue.push(...items);
    await store.saveQueue();
    store.log('info', `Added ${prompts.length} prompt${prompts.length === 1 ? '' : 's'} (${items.length} in the queue).`);
    return { added: items.length };
  },
  async removeItem({ id }) {
    const i = store.queue.findIndex((x) => x.id === id);
    if (i === -1 || (store.queue[i].status === STATUS.RUNNING && engine.busy)) return { ok: false };
    store.queue.splice(i, 1);
    await store.saveQueue();
    return {};
  },
  async toggleNewChat({ id }) {
    const item = store.queue.find((x) => x.id === id);
    if (!item || item.status !== STATUS.QUEUED) return { ok: false };
    item.newChat = !item.newChat;
    await store.saveQueue();
    return {};
  },
  async toggleImageMode({ id }) {
    const item = store.queue.find((x) => x.id === id);
    if (!item || item.status !== STATUS.QUEUED || !expectsImages(item.mode)) return { ok: false };
    item.imageMode = item.imageMode === 'last' ? 'new' : 'last';
    await store.saveQueue();
    return {};
  },
  async rerunItem({ id }) {
    const item = store.queue.find((x) => x.id === id);
    if (!item || item.status === STATUS.RUNNING || item.status === STATUS.QUEUED) return { ok: false };
    Object.assign(item, fresh(), { status: STATUS.QUEUED });
    await store.saveQueue();
    return {};
  },
  async retryFailed() {
    let n = 0;
    for (const item of store.queue) {
      if (item.status === STATUS.FAILED || item.status === STATUS.REFUSED) {
        Object.assign(item, { status: STATUS.QUEUED, retries: 0, refusals: 0, interruptions: 0, error: '' });
        n++;
      }
    }
    await store.saveQueue();
    if (n) store.log('info', `${n} prompt${n === 1 ? '' : 's'} queued again.`);
    return { n };
  },
  async resetQueue() {
    if (engine.busy) return { ok: false };
    store.queue.forEach((item) => Object.assign(item, fresh(), { status: STATUS.QUEUED }));
    await store.saveQueue();
    await chrome.storage.local.remove('lastImage');
    return {};
  },
  async clearQueue() {
    if (engine.busy) return { ok: false };
    store.queue.splice(0, store.queue.length);
    await store.saveQueue();
    await chrome.storage.local.remove('lastImage');
    return {};
  },
  async clearLog() {
    await store.clearLog();
    return {};
  },
  async diagnostics() {
    return { page: await engine.diagnostics() };
  },
};

/** Fields of an item reset when it is run again from scratch. */
function fresh() {
  return {
    retries: 0, interruptions: 0, refusals: 0, attempts: 0, error: '', output: '', imageCount: 0, thumbs: [], phase: '',
    convId: '', chatUrl: '', userMsgId: '', submittedAt: 0, lastKind: '', startedAt: 0, finishedAt: 0,
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only the extension's own pages (the panel) may send commands; content scripts can't.
  const fromExtensionPage = sender.id === chrome.runtime.id && String(sender.url || '').startsWith(chrome.runtime.getURL(''));
  if (!msg || typeof msg.cmd !== 'string' || !COMMANDS[msg.cmd] || !fromExtensionPage) return false;
  store.load()
    .then(() => COMMANDS[msg.cmd](msg.args || {}))
    .then((res) => sendResponse({ ok: true, ...res }), (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});
