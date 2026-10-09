import { api, browserName } from '../lib/browser.js';
import { STATUS, buildFilename, parseCsvPrompts, parsePrompts, summarize } from '../lib/utils.js';
import { LANGUAGES, apply, detectLanguage, setLanguage, t } from './i18n.js';
import { MODES, MODE_LIST, assetKind, expectsImages, makeItems } from './modes.js';
import { Engine } from './engine.js';

const KEYS = { settings: 'cga_settings', queue: 'cga_queue', assets: 'cga_assets', lastImage: 'cga_last_image', draft: 'cga_draft' };

export const DEFAULT_SETTINGS = {
  language: null,
  mode: MODES.TEXT,
  defaultMode: MODES.TEXT,
  textOutputs: 1,
  imageOutputs: 1,
  concurrency: 1,
  minDelay: 3,
  maxDelay: 8,
  textModel: '',
  imageModel: '',
  defaultPromptMode: 'new',
  defaultImageMode: 'new',
  maxIngredientImages: 3,
  maxImageInputs: 4,
  maxRetries: 3,
  timeoutMinutes: 10,
  textDownload: 'md',
  imageDownload: 'original',
  aspectRatio: '',
  autoAddCharacters: true,
  folder: 'ChatGPT-Automation',
  renameFiles: true,
  keepTabActive: true,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// ---- State: the panel is the only writer, so the in-memory copy is the source of truth. ----
let settings = { ...DEFAULT_SETTINGS };
let queue = [];
let assets = { sourceImages: [], ingredients: [] };
// Firefox treats host permissions as optional: the user may have to grant chatgpt.com access.
const HOSTS = ['https://chatgpt.com/*', 'https://chat.openai.com/*'];
let hostAccess = true;
let bgStream = null;

const store = {
  getSettings: async () => ({ ...settings }),
  getQueue: async () => queue,
  saveQueue: async (q) => {
    queue = q;
    await api.storage.local.set({ [KEYS.queue]: queue });
  },
  getAssets: async () => assets,
  getLastImage: async () => (await api.storage.local.get(KEYS.lastImage))[KEYS.lastImage] || null,
  setLastImage: (img) => api.storage.local.set({ [KEYS.lastImage]: img }),
};

const saveSettings = () => api.storage.local.set({ [KEYS.settings]: settings });
const saveAssets = () => api.storage.local.set({ [KEYS.assets]: assets });
const saveQueue = () => store.saveQueue(queue);

const engine = new Engine(store, {
  onChange: () => render(),
  onLog: (kind, key, params) => log(kind, t(key, params)),
});

init();

async function init() {
  const stored = await api.storage.local.get([KEYS.settings, KEYS.queue, KEYS.assets, KEYS.draft]);
  settings = { ...DEFAULT_SETTINGS, ...(stored[KEYS.settings] || {}) };
  settings.mode = MODE_LIST.includes(settings.defaultMode) ? settings.defaultMode : MODES.TEXT;
  queue = stored[KEYS.queue] || [];
  assets = { sourceImages: [], ingredients: [], ...(stored[KEYS.assets] || {}) };
  // A previous panel may have closed mid-run: that prompt may already be in the chat.
  queue.forEach((i) => { if (i.status === STATUS.RUNNING) Object.assign(i, { status: STATUS.QUEUED, interrupted: true }); });
  hostAccess = await api.permissions.contains({ origins: HOSTS }).catch(() => true);
  $('#promptInput').value = stored[KEYS.draft] || '';

  if (!settings.language) settings.language = detectLanguage();
  const langSelect = $('#language');
  langSelect.replaceChildren(...LANGUAGES.map((l) => new Option(l.label, l.code)));
  langSelect.value = settings.language;
  langSelect.addEventListener('change', async () => {
    settings.language = langSelect.value;
    await saveSettings();
    await setLanguage(settings.language);
    render();
  });
  await setLanguage(settings.language);

  bindPages();
  bindSettings();
  bindModes();
  bindAssets();
  bindPrompts();
  bindControls();
  render();
  setInterval(renderStatus, 1000);
}

// ---- Pages (Control / Setting) ----
function bindPages() {
  let page = 'control';
  try { page = localStorage.getItem('cga_page') || 'control'; } catch { /* storage blocked */ }
  const show = (name) => {
    $$('.pagetabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.page === name)));
    $$('.page').forEach((p) => { p.hidden = p.id !== `page-${name}`; });
    try { localStorage.setItem('cga_page', name); } catch { /* ignore */ }
  };
  $$('.pagetabs button').forEach((b) => b.addEventListener('click', () => show(b.dataset.page)));
  show(page === 'setting' ? 'setting' : 'control');
}

// ---- Settings: every [data-setting] element; one key may appear on both pages ----
function bindSettings() {
  const fill = () => $$('[data-setting]').forEach((el) => {
    const key = el.dataset.setting;
    if (el.type === 'checkbox') el.checked = !!settings[key];
    else el.value = settings[key] ?? '';
  });
  fill();
  $$('[data-setting]').forEach((el) => {
    el.addEventListener('change', () => {
      const key = el.dataset.setting;
      let value = el.type === 'checkbox' ? el.checked : el.value;
      if (el.type === 'number') {
        const min = el.min === '' ? -Infinity : Number(el.min);
        const max = el.max === '' ? Infinity : Number(el.max);
        value = Math.min(max, Math.max(min, Math.round(Number(value)) || (min > 0 ? min : 0)));
      }
      if (el.type === 'text') value = String(value).trim();
      settings[key] = value;
      if (key === 'minDelay' || key === 'maxDelay') {
        if (settings.minDelay > settings.maxDelay) {
          if (key === 'minDelay') settings.maxDelay = settings.minDelay;
          else settings.minDelay = settings.maxDelay;
        }
      }
      saveSettings();
      fill();
      render();
    });
  });
}

function bindModes() {
  $$('#modeTabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      settings.mode = btn.dataset.mode;
      saveSettings();
      render();
    });
  });
}

// ---- Uploaded images (Ingredients / Image to Image) ----
function bindAssets() {
  $('#assetInput').addEventListener('change', async (e) => {
    const kind = assetKind(settings.mode);
    const files = [...e.target.files];
    e.target.value = '';
    if (!kind || !files.length) return;
    assets[kind].push(...(await Promise.all(files.map(readAsDataUrl))));
    await saveAssets();
    renderAssets();
  });
  $('#clearAssets').addEventListener('click', async () => {
    const kind = assetKind(settings.mode);
    if (!kind) return;
    assets[kind] = [];
    await saveAssets();
    renderAssets();
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
  const kind = assetKind(settings.mode);
  $('#assetsBox').hidden = !kind;
  if (!kind) return;
  $('#assetsTitle').textContent = t(kind === 'ingredients' ? 'ingredientImages' : 'sourceImages');
  $('#thumbs').replaceChildren(...assets[kind].map((a, idx) => {
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
}

// ---- Prompts ----
function bindPrompts() {
  const input = $('#promptInput');
  input.addEventListener('input', () => {
    api.storage.local.set({ [KEYS.draft]: input.value });
    renderPromptCount();
  });
  $('#importFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const text = await file.text();
    const prompts = /\.csv$/i.test(file.name) ? parseCsvPrompts(text) : parsePrompts(text);
    input.value = [input.value.trim(), prompts.join('\n\n')].filter(Boolean).join('\n\n');
    api.storage.local.set({ [KEYS.draft]: input.value });
    renderPromptCount();
  });
}

function renderPromptCount() {
  const n = parsePrompts($('#promptInput').value).length;
  $('#promptCount').textContent = n ? t('promptCount', [n]) : '';
}

/** Moves the prompts typed in the box into the queue, in the current mode. */
function queuePrompts() {
  const input = $('#promptInput');
  const prompts = parsePrompts(input.value);
  if (!prompts.length) return 0;
  const mode = settings.mode;
  const items = makeItems(prompts, {
    mode,
    firstIndex: queue.reduce((m, i) => Math.max(m, i.index + 1), 0),
    outputs: expectsImages(mode) ? settings.imageOutputs : settings.textOutputs,
    chatMode: settings.defaultPromptMode,
    imageMode: settings.defaultImageMode,
  });
  queue.push(...items);
  input.value = '';
  api.storage.local.set({ [KEYS.draft]: '' });
  log('info', t('logAdded', [prompts.length, items.length]));
  return items.length;
}

// ---- Controls ----
const CLEAR_CONFIRM_MS = 4000;
let clearArmedUntil = 0;
let clearDisarm = null;

function bindControls() {
  $('#runBtn').addEventListener('click', () => {
    if (engine.busy) return;
    queuePrompts();
    if (!queue.some((i) => i.status === STATUS.QUEUED)) {
      log('warn', t('logNoPrompts'));
      render();
      return;
    }
    const needsSources = queue.some((i) => i.status === STATUS.QUEUED && i.mode === MODES.IMAGE_TO_IMAGE && i.imageMode !== 'last');
    if (needsSources && !assets.sourceImages.length) {
      log('error', t('logNeedSourceImages'));
      saveQueue();
      render();
      return;
    }
    saveQueue();
    render();
    if (hostAccess) {
      engine.start();
      return;
    }
    // Must be requested straight from the click (no await before it) or the browser refuses.
    api.permissions.request({ origins: HOSTS }).then((granted) => {
      hostAccess = granted;
      if (granted) engine.start();
      else log('warn', t('logNeedHostAccess'));
    }, (e) => log('error', String(e?.message || e)));
  });
  $('#stopBtn').addEventListener('click', () => engine.stop());
  $('#fixBtn').addEventListener('click', async () => {
    await engine.fix();
    render();
  });
  $('#copyDiagnosticsBtn').addEventListener('click', copyDiagnostics);

  $('#retryFailedBtn').addEventListener('click', () => {
    queue.forEach((i) => {
      if (i.status === STATUS.FAILED || i.status === STATUS.REFUSED) Object.assign(i, { status: STATUS.QUEUED, retries: 0, refusals: 0, interruptions: 0, error: '' });
    });
    saveQueue();
    render();
  });
  $('#resetBtn').addEventListener('click', () => {
    if (engine.busy) return;
    queue.forEach((i) => Object.assign(i, {
      status: STATUS.QUEUED, retries: 0, refusals: 0, interruptions: 0, interrupted: false, error: '', output: '', imageCount: 0, chatUrl: '',
    }));
    api.storage.local.remove(KEYS.lastImage);
    saveQueue();
    render();
  });
  $('#clearBtn').addEventListener('click', () => {
    if (engine.busy || !queue.length) return;
    // Two clicks instead of confirm(): browser dialogs don't reliably show in side panels.
    if (Date.now() > clearArmedUntil) {
      clearArmedUntil = Date.now() + CLEAR_CONFIRM_MS;
      clearTimeout(clearDisarm);
      clearDisarm = setTimeout(render, CLEAR_CONFIRM_MS + 50);
      render();
      return;
    }
    clearArmedUntil = 0;
    queue = [];
    api.storage.local.remove(KEYS.lastImage);
    saveQueue();
    render();
  });

  $('#queueList').addEventListener('click', (e) => {
    const li = e.target.closest('.qi');
    const item = li && queue.find((i) => i.id === li.dataset.id);
    if (!item) return;
    if (e.target.closest('.qi-remove')) {
      if (item.status === STATUS.RUNNING) return;
      queue.splice(queue.indexOf(item), 1);
    } else if (e.target.closest('.qi-rerun')) {
      if (item.status === STATUS.RUNNING) return;
      Object.assign(item, { status: STATUS.QUEUED, retries: 0, refusals: 0, interruptions: 0, interrupted: false, error: '' });
    } else if (e.target.closest('.qi-option')) {
      if (item.status !== STATUS.QUEUED || engine.busy) return;
      if (expectsImages(item.mode)) item.imageMode = item.imageMode === 'last' ? 'new' : 'last';
      else item.chatMode = item.chatMode === 'concat' ? 'new' : 'concat';
    } else return;
    saveQueue();
    render();
  });

  // Background mode: sharing the ChatGPT tab keeps the browser from pausing it behind other windows.
  const canShare = !!navigator.mediaDevices?.getDisplayMedia;
  $('#bgBtn').hidden = !canShare;
  $('#bgBtn').addEventListener('click', enableBackground);
  $('#bgOff').addEventListener('click', stopBackground);
}

async function enableBackground() {
  try {
    bgStream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser' },
      audio: false,
      preferCurrentTab: false,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'exclude',
    });
    bgStream.getVideoTracks()[0]?.addEventListener('ended', stopBackground);
    log('success', t('logBackgroundOn'));
  } catch (e) {
    bgStream = null;
    log('warn', t('logBackgroundFailed', [String(e?.message || e)]));
  }
  render();
}

function stopBackground() {
  if (!bgStream) return;
  bgStream.getTracks().forEach((tr) => tr.stop());
  bgStream = null;
  log('info', t('logBackgroundOff'));
  render();
}

// ---- Rendering ----
function render() {
  $$('#modeTabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === settings.mode)));
  $('#modeHint').textContent = t(`modeHint_${settings.mode}`);
  $('#aspectField').hidden = !expectsImages(settings.mode);
  renderAssets();
  renderPromptCount();

  const sample = parsePrompts($('#promptInput').value)[0] || queue[0]?.prompt || t('samplePrompt');
  const ext = expectsImages(settings.mode) ? 'png' : settings.textDownload === 'txt' ? 'txt' : 'md';
  $('#filenamePreview').textContent = `${t('downloadsFolder')}/${buildFilename({ folder: settings.folder, index: 0, prompt: sample, ext, rename: settings.renameFiles })}`;

  $('#bgBadge').hidden = !bgStream;
  $('#bgBtn').disabled = !!bgStream;
  renderQueue();
  renderStatus();
}

function renderQueue() {
  const list = $('#queueList');
  const tpl = $('#queueItemTpl');
  const counts = summarize(queue);
  const busy = engine.busy;
  const active = new Map(engine.active.map((a) => [a.id, a]));

  $('#queueEmpty').hidden = queue.length > 0;
  $('#progressBar').style.width = `${counts.percent}%`;
  $('#counts').textContent = queue.length ? t('countsLine', [counts.completed, counts.total, counts.failed, counts.refused]) : '';

  $('#runBtn').disabled = busy;
  $('#stopBtn').disabled = !busy;
  $('#retryFailedBtn').disabled = !counts.failed && !counts.refused;
  $('#resetBtn').disabled = busy || !counts.done;
  $('#clearBtn').disabled = busy || !queue.length;
  const armed = Date.now() < clearArmedUntil && !busy && queue.length > 0;
  $('#clearBtn').textContent = t(armed ? 'confirmClearAgain' : 'clearQueue');
  $('#clearBtn').classList.toggle('danger', armed);

  list.replaceChildren(...queue.map((item) => {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = item.id;
    node.classList.add(item.status);
    node.querySelector('.qi-num').textContent = item.copies > 1 ? `${item.index + 1}.${item.copy + 1}` : `${item.index + 1}.`;
    const p = node.querySelector('.qi-prompt');
    p.textContent = item.prompt;
    p.title = item.output ? `${item.prompt}\n\n— ${item.output.slice(0, 500)}` : item.prompt;
    const chip = node.querySelector('.chip.status');
    chip.classList.add(item.status);
    const now = active.get(item.id);
    chip.textContent = now?.status && t(`phase_${now.status}`) !== `phase_${now.status}` ? t(`phase_${now.status}`) : t(`status_${item.status}`);
    node.querySelector('.qi-mode').textContent = t(`modeShort_${item.mode || MODES.TEXT}`);
    const opt = node.querySelector('.qi-option');
    opt.textContent = expectsImages(item.mode) ? t(`imageMode_${item.imageMode || 'new'}`) : t(`chatMode_${item.chatMode || 'new'}`);
    opt.disabled = item.status !== STATUS.QUEUED || busy;
    opt.title = t('optionToggleHint');
    const extra = [];
    if (item.retries) extra.push(t('retriesCount', [item.retries, settings.maxRetries]));
    if (item.imageCount) extra.push(t('imagesCount', [item.imageCount]));
    node.querySelector('.qi-extra').textContent = extra.join(' · ');
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
  if (engine.state === 'running') {
    const secs = Math.ceil(((engine.waitUntil || 0) - Date.now()) / 1000);
    text = secs > 0 && !engine.active.length ? t('runnerWaiting', [secs]) : t('runnerRunning', [engine.active.length]);
  }
  if (engine.state === 'stopping') text = t('runnerStopping');
  pill.textContent = text;
  pill.classList.toggle('active', engine.busy);
}

// ---- Diagnostics ----
async function copyDiagnostics() {
  const page = await engine.diagnostics().catch((e) => ({ error: String(e?.message || e) }));
  const report = {
    extension: `bash-auto ${api.runtime.getManifest().version}`,
    browser: browserName(),
    userAgent: navigator.userAgent,
    panelLanguage: settings.language,
    mode: settings.mode,
    settings: { concurrency: settings.concurrency, timeoutMinutes: settings.timeoutMinutes, keepTabActive: settings.keepTabActive, textModel: settings.textModel, imageModel: settings.imageModel },
    engine: engine.state,
    backgroundMode: !!bgStream,
    queue: summarize(queue),
    recentErrors: queue.filter((i) => i.error).slice(-5).map((i) => `#${i.index + 1}: ${i.error}`),
    page: page || 'No ChatGPT tab answered. Open chatgpt.com and try again.',
    log: $$('#log li').slice(0, 60).map((li) => li.textContent),
  };
  const text = JSON.stringify(report, null, 2);
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  log('info', t('logDiagnosticsCopied'));
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
  while (ul.children.length > 400) ul.lastChild.remove();
}
