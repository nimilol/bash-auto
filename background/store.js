// The service worker owns the queue, the run state and the activity log, and saves every change
// to chrome.storage.local at once. The panel only reads them (and listens for changes), so the
// two never overwrite each other. Settings and uploaded images are written by the panel and read
// here before each prompt.
import { normalizeSettings } from '../lib/utils.js';

export const KEYS = Object.freeze({
  settings: 'settings',
  queue: 'queue',
  run: 'run',
  log: 'log',
  assets: 'assets',
  lastImage: 'lastImage',
  draft: 'draft',
});

const LOG_MAX = 400;

export const IDLE_RUN = Object.freeze({
  state: 'idle', // idle | running | stopping | waitingNetwork | waitingLogin | paused
  pause: '', // why the run is paused: 'tooLong'
  message: '',
  convId: '', // the run's chat: every prompt goes here unless told otherwise
  chatUrl: '',
  lastAnchorId: '', // the user message of the last finished prompt in that chat
  tabId: null,
  currentId: '',
  waitUntil: 0,
  startedAt: 0,
});

export function createStore(storage = globalThis.chrome?.storage?.local) {
  const state = { queue: [], run: { ...IDLE_RUN }, log: [] };
  let loaded = null;
  let logTimer = null;

  const store = {
    state,
    async load() {
      if (!loaded) {
        loaded = storage.get([KEYS.queue, KEYS.run, KEYS.log]).then((s) => {
          state.queue = Array.isArray(s[KEYS.queue]) ? s[KEYS.queue] : [];
          state.run = { ...IDLE_RUN, ...(s[KEYS.run] || {}) };
          state.log = Array.isArray(s[KEYS.log]) ? s[KEYS.log] : [];
        });
      }
      return loaded;
    },
    get queue() { return state.queue; },
    get run() { return state.run; },
    async saveQueue() {
      await storage.set({ [KEYS.queue]: state.queue });
    },
    async setRun(patch) {
      Object.assign(state.run, patch);
      await storage.set({ [KEYS.run]: state.run });
    },
    async settings() {
      const s = await storage.get(KEYS.settings);
      return normalizeSettings(s[KEYS.settings]);
    },
    async assets() {
      const s = await storage.get(KEYS.assets);
      return { sourceImages: [], ingredients: [], ...(s[KEYS.assets] || {}) };
    },
    async lastImage() {
      return (await storage.get(KEYS.lastImage))[KEYS.lastImage] || null;
    },
    setLastImage(img) {
      return img ? storage.set({ [KEYS.lastImage]: img }) : storage.remove(KEYS.lastImage);
    },
    log(kind, text) {
      state.log.push({ t: Date.now(), kind, text: String(text) });
      if (state.log.length > LOG_MAX) state.log.splice(0, state.log.length - LOG_MAX);
      clearTimeout(logTimer);
      logTimer = setTimeout(() => storage.set({ [KEYS.log]: state.log }).catch(() => {}), 150);
    },
    async clearLog() {
      state.log = [];
      await storage.set({ [KEYS.log]: [] });
    },
    async flushLog() {
      clearTimeout(logTimer);
      await storage.set({ [KEYS.log]: state.log });
    },
  };
  return store;
}
