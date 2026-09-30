import { STATUS, buildFilename, parseCsvPrompts, parsePrompts, summarize } from '../lib/utils.js';
import { LANGUAGES, apply, detectLanguage, setLanguage, t } from './i18n.js';
import { MODES } from './modes.js';
import { Runner } from './runner.js';

const KEYS = { settings: 'cga_settings', queue: 'cga_queue', assets: 'cga_assets', lastImage: 'cga_last_image', session: 'cga_session' };

const DEFAULT_SETTINGS = {
  mode: MODES.TEXT,
  language: null,
  concat: false,
  aspectRatio: '1:1',
  saveTextWithImages: false,
  chain: false,
  autoMatchIngredients: true,
  minDelay: 5,
  maxDelay: 15,
  maxRetries: 2,
  refusalRetries: 1,
  singleChat: true,
  timeoutMinutes: 10,
  newChatPerPrompt: true,
  newChatOnStart: true,
  autoDownload: true,
  project: 'my-project',
  renameByPrompt: true,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// ---- Storage: the panel is the only writer, so the in-memory copy is the source of truth. ----
let settings = { ...DEFAULT_SETTINGS };
let queue = [];
let assets = { sourceImages: [], ingredients: [] };
let session = null; // { chatUrl, startedAt }: the one conversation this queue runs in

const store = {
  getSettings: async () => ({ ...settings }),
  getQueue: async () => queue,
  saveQueue: async (q) => {
    queue = q;
    await chrome.storage.local.set({ [KEYS.queue]: queue });
  },
  getAssets: async () => assets,
  getLastImage: async () => (await chrome.storage.local.get(KEYS.lastImage))[KEYS.lastImage] || null,
  setLastImage: (img) => chrome.storage.local.set({ [KEYS.lastImage]: img }),
  getSession: async () => session,
  setSession: async (value) => {
    session = value;
    if (value) await chrome.storage.local.set({ [KEYS.session]: value });
    else await chrome.storage.local.remove(KEYS.session);
  },
};

const saveSettings = () => chrome.storage.local.set({ [KEYS.settings]: settings });
const saveAssets = () => chrome.storage.local.set({ [KEYS.assets]: assets });
const saveQueue = () => store.saveQueue(queue);

// ---- Runner ----
const runner = new Runner(store, {
  onChange: () => render(),
  onLog: (kind, key, params) => log(kind, t(key, params)),
});

// ---- Init ----
init();

async function init() {
  const stored = await chrome.storage.local.get([KEYS.settings, KEYS.queue, KEYS.assets, KEYS.session]);
  settings = { ...DEFAULT_SETTINGS, ...(stored[KEYS.settings] || {}) };
  queue = stored[KEYS.queue] || [];
  assets = { sourceImages: [], ingredients: [], ...(stored[KEYS.assets] || {}) };
  session = stored[KEYS.session] || null;
  // A previous panel may have closed mid-run: that prompt may already be in the chat.
  queue.forEach((i) => { if (i.status === STATUS.RUNNING) Object.assign(i, { status: STATUS.QUEUED, interrupted: true }); });

  if (!settings.language) settings.language = detectLanguage();
  const langSelect = $('#language');
  langSelect.innerHTML = LANGUAGES.map((l) => `<option value="${l.code}">${l.label}</option>`).join('');
  langSelect.value = settings.language;
  langSelect.addEventListener('change', async () => {
    settings.language = langSelect.value;
    await saveSettings();
    await setLanguage(settings.language);
    render();
  });
  await setLanguage(settings.language);

  bindSettings();
  bindModeTabs();
  bindAssets();
  bindPrompts();
  bindControls();
  render();
  setInterval(renderStatus, 1000);
}

// ---- Settings ----
function bindSettings() {
  $$('[data-setting]').forEach((el) => {
    const key = el.dataset.setting;
    if (el.type === 'checkbox') el.checked = !!settings[key];
    else el.value = settings[key] ?? '';
    el.addEventListener('change', () => {
      settings[key] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
      if (key === 'minDelay' || key === 'maxDelay') {
        settings.minDelay = Math.max(0, settings.minDelay || 0);
        settings.maxDelay = Math.max(settings.minDelay, settings.maxDelay || 0);
        $('[data-setting="minDelay"]').value = settings.minDelay;
        $('[data-setting="maxDelay"]').value = settings.maxDelay;
      }
      saveSettings();
      render();
    });
  });
}

function bindModeTabs() {
  $$('#modeTabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (runner.busy) return;
      settings.mode = btn.dataset.mode;
      saveSettings();
      render();
    });
  });
}

// ---- Image assets (source images / ingredients) ----
function bindAssets() {
  $$('.assets').forEach((box) => {
    const kind = box.dataset.asset;
    box.querySelector('input[type=file]').addEventListener('change', async (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      const read = await Promise.all(files.map(readAsDataUrl));
      assets[kind].push(...read);
      await saveAssets();
      renderAssets();
    });
    box.querySelector('[data-clear-assets]').addEventListener('click', async () => {
      assets[kind] = [];
      await saveAssets();
      renderAssets();
    });
  });
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ name: file.name, dataUrl: r.result });
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function renderAssets() {
  $$('.assets').forEach((box) => {
    const kind = box.dataset.asset;
    const wrap = box.querySelector('.thumbs');
    wrap.replaceChildren(...assets[kind].map((a, idx) => {
      const div = document.createElement('div');
      div.className = 'thumb';
      const img = document.createElement('img');
      img.src = a.dataUrl;
      img.alt = a.name;
      const name = document.createElement('span');
      name.textContent = a.name;
      name.title = a.name;
      const rm = document.createElement('button');
      rm.textContent = '✕';
      rm.title = t('remove');
      rm.addEventListener('click', async () => {
        assets[kind].splice(idx, 1);
        await saveAssets();
        renderAssets();
      });
      div.append(img, name, rm);
      return div;
    }));
  });
}

// ---- Prompts ----
function bindPrompts() {
  $('#addPrompts').addEventListener('click', () => {
    const input = $('#promptInput');
    if (addPrompts(parsePrompts(input.value))) input.value = '';
  });
  $('#importFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const text = await file.text();
    addPrompts(/\.csv$/i.test(file.name) ? parseCsvPrompts(text) : parsePrompts(text));
  });
}

function addPrompts(prompts) {
  if (!prompts.length) {
    log('warn', t('logNoPrompts'));
    return false;
  }
  for (const prompt of prompts) {
    queue.push({ id: crypto.randomUUID(), index: queue.length, prompt, status: STATUS.QUEUED, retries: 0, error: '' });
  }
  saveQueue();
  log('info', t('logAdded', [prompts.length]));
  render();
  return true;
}

function reindex() {
  queue.forEach((item, i) => { item.index = i; });
}

// ---- Controls ----
function bindControls() {
  $('#startBtn').addEventListener('click', () => runner.start());
  $('#pauseBtn').addEventListener('click', () => runner.pause());
  $('#stopBtn').addEventListener('click', () => runner.stop());
  $('#retryFailedBtn').addEventListener('click', () => {
    queue.forEach((i) => {
      if (i.status === STATUS.FAILED || i.status === STATUS.REFUSED) Object.assign(i, { status: STATUS.QUEUED, retries: 0, refusals: 0, interruptions: 0, error: '' });
    });
    saveQueue();
    render();
  });
  $('#resetBtn').addEventListener('click', () => {
    if (runner.busy) return;
    queue.forEach((i) => Object.assign(i, {
      status: STATUS.QUEUED, retries: 0, refusals: 0, interruptions: 0, interrupted: false, error: '', output: '', imageCount: 0, chatUrl: '',
    }));
    chrome.storage.local.remove(KEYS.lastImage);
    saveQueue();
    render();
  });
  $('#clearBtn').addEventListener('click', () => {
    if (runner.busy || !queue.length || !confirm(t('confirmClear'))) return;
    queue = [];
    chrome.storage.local.remove(KEYS.lastImage);
    store.setSession(null);
    saveQueue();
    render();
  });

  $('#newSessionBtn').addEventListener('click', async () => {
    if (runner.busy) return;
    await store.setSession(null);
    log('info', t('logNewSession'));
    render();
  });

  $('#queueList').addEventListener('click', (e) => {
    const li = e.target.closest('.qi');
    if (!li) return;
    const item = queue.find((i) => i.id === li.dataset.id);
    if (!item) return;
    if (e.target.closest('.qi-remove')) {
      if (item.status === STATUS.RUNNING) return;
      queue.splice(queue.indexOf(item), 1);
      reindex();
      saveQueue();
      render();
    } else if (e.target.closest('.qi-rerun')) {
      if (item.status === STATUS.RUNNING) return;
      Object.assign(item, { status: STATUS.QUEUED, retries: 0, refusals: 0, interruptions: 0, error: '' });
      saveQueue();
      render();
    }
  });
}

// ---- Rendering ----
function render() {
  // Mode tabs + options
  $$('#modeTabs button').forEach((b) => {
    b.setAttribute('aria-selected', String(b.dataset.mode === settings.mode));
    b.disabled = runner.busy && b.dataset.mode !== settings.mode;
  });
  $$('.mode-opts').forEach((el) => { el.hidden = !el.dataset.for.split(' ').includes(settings.mode); });
  $('#modeHint').textContent = t(`modeHint_${settings.mode}`);
  renderAssets();
  for (const key of ['newChatPerPrompt', 'newChatOnStart']) {
    $(`[data-setting="${key}"]`).disabled = !!settings.singleChat;
  }

  // Session chat
  const link = $('#sessionLink');
  link.hidden = !session?.chatUrl;
  if (session?.chatUrl) link.href = session.chatUrl;
  $('#sessionNone').hidden = !!session?.chatUrl;
  $('#sessionRow').hidden = !settings.singleChat;
  $('#newSessionBtn').disabled = runner.busy || !session;

  // Filename preview
  const sample = queue[0]?.prompt || t('samplePrompt');
  const ext = settings.mode === MODES.TEXT_TO_IMAGE || settings.mode === MODES.IMAGE_TO_IMAGE ? 'png' : 'md';
  $('#filenamePreview').textContent = `${t('downloadsFolder')}/${buildFilename({
    project: settings.project, index: 0, prompt: sample, ext, renameByPrompt: settings.renameByPrompt,
  })}`;

  renderQueue();
  renderStatus();
}

function renderQueue() {
  const list = $('#queueList');
  const tpl = $('#queueItemTpl');
  const counts = summarize(queue);

  $('#queueEmpty').hidden = queue.length > 0;
  $('#progressBar').style.width = `${counts.percent}%`;
  $('#counts').textContent = t('countsLine', [counts.completed, counts.total, counts.running, counts.queued, counts.failed, counts.refused, counts.percent]);

  const busy = runner.busy;
  $('#startBtn').disabled = busy || !counts.queued;
  $('#pauseBtn').disabled = !busy || runner.state === 'pausing';
  $('#stopBtn').disabled = !busy;
  $('#retryFailedBtn').disabled = !counts.failed && !counts.refused;
  $('#resetBtn').disabled = busy || !queue.length;
  $('#clearBtn').disabled = busy || !queue.length;
  $('#startBtn').textContent = t(counts.done && counts.queued ? 'resume' : 'start');

  list.replaceChildren(...queue.map((item) => {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = item.id;
    node.classList.add(item.status);
    node.querySelector('.qi-num').textContent = `${item.index + 1}.`;
    const p = node.querySelector('.qi-prompt');
    p.textContent = item.prompt;
    p.title = item.output ? `${item.prompt}\n\n— ${item.output.slice(0, 500)}` : item.prompt;
    const chip = node.querySelector('.chip');
    chip.className = `chip ${item.status}`;
    chip.textContent = t(`status_${item.status}`);
    node.querySelector('.qi-retries').textContent = item.retries ? t('retriesCount', [Math.min(item.retries, settings.maxRetries), settings.maxRetries]) : '';
    node.querySelector('.qi-extra').textContent = item.imageCount ? t('imagesCount', [item.imageCount]) : '';
    const link = node.querySelector('.qi-link');
    if (item.chatUrl) { link.href = item.chatUrl; link.hidden = false; }
    const err = node.querySelector('.qi-error');
    if (item.error && item.status !== STATUS.COMPLETED) {
      err.textContent = item.error;
      err.hidden = false;
      err.classList.toggle('muted', item.status === STATUS.REFUSED);
    }
    node.querySelector('.qi-rerun').disabled = item.status === STATUS.RUNNING || item.status === STATUS.QUEUED;
    node.querySelector('.qi-remove').disabled = item.status === STATUS.RUNNING;
    apply(node);
    return node;
  }));
}

function renderStatus() {
  const pill = $('#runnerStatus');
  let text = t('runnerIdle');
  if (runner.state === 'running') text = t('runnerRunning');
  if (runner.state === 'pausing') text = t('runnerPausing');
  if (runner.state === 'waiting') {
    const secs = Math.max(0, Math.ceil((runner.waitUntil - Date.now()) / 1000));
    text = t('runnerWaiting', [secs]);
  }
  pill.textContent = text;
  pill.classList.toggle('active', runner.busy);
}

// ---- Log ----
function log(kind, message) {
  const ul = $('#log');
  const li = document.createElement('li');
  li.className = kind;
  const time = document.createElement('time');
  time.textContent = new Date().toLocaleTimeString();
  li.append(time, document.createTextNode(message));
  ul.prepend(li);
  while (ul.children.length > 300) ul.lastChild.remove();
}
