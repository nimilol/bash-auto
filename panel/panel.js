// The side panel. It shows the run and sends commands to the service worker, which does the work.
// The queue, run state and log are read from storage and re-rendered when they change, so the panel
// can be closed and reopened at any time without affecting the run.
import {
  MODES, STATUS, assetKind, buildFilename, expectsImages, formatDuration, normalizeSettings, parseCsvPrompts, parsePrompts, summarize,
} from '../lib/utils.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

let settings = normalizeSettings({});
let queue = [];
let run = { state: 'idle' };
let log = [];
let assets = { sourceImages: [], ingredients: [] };
let seenLog = 0;
let page = 'run';

const MODE_HINTS = {
  textToImage: 'Each prompt asks ChatGPT for an image. All prompts go into one chat, and each image is saved as soon as it is finished.',
  imageToImage: 'Each prompt is sent with your source images to transform them. Add the images below.',
  text: 'Each prompt gets a text reply, saved as a file.',
  ingredients: 'Each prompt is sent with your images (matched by file name when enabled) and gets a text reply.',
};
const STATE_LABELS = {
  idle: 'Idle', running: 'Running', stopping: 'Stopping…', waitingNetwork: 'Waiting for network', waitingLogin: 'Waiting for login', paused: 'Paused',
};
const PHASES = {
  preparing: 'Preparing', typing: 'Sending', sent: 'Sent', replying: 'Replying', image: 'Generating image', nudged: 'Asked again',
  saving: 'Saving', network: 'Waiting for network',
};

const isActive = () => ['running', 'stopping', 'waitingNetwork', 'waitingLogin'].includes(run.state);
const send = (cmd, args = {}) => chrome.runtime.sendMessage({ cmd, args }).catch((e) => ({ ok: false, error: String(e?.message || e) }));

init();

async function init() {
  const s = await chrome.storage.local.get(['settings', 'queue', 'run', 'log', 'assets', 'draft']);
  settings = normalizeSettings(s.settings);
  queue = s.queue || [];
  run = s.run || { state: 'idle' };
  log = s.log || [];
  assets = { sourceImages: [], ingredients: [], ...(s.assets || {}) };
  $('#prompts').value = s.draft || '';
  try { seenLog = Number(localStorage.getItem('seenLog')) || 0; } catch { /* storage blocked */ }

  bindTabs();
  bindSettings();
  bindRun();
  bindQueue();
  bindActivity();
  renderAll();
  // Ask the worker for its state once: it also wakes it up and lets it resume a run.
  send('state');

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.settings) { settings = normalizeSettings(changes.settings.newValue); fillSettings(); renderRunCard(); }
    if (changes.queue) { queue = changes.queue.newValue || []; renderQueue(); }
    if (changes.run) { run = changes.run.newValue || { state: 'idle' }; renderRunCard(); renderQueue(); }
    if (changes.log) { log = changes.log.newValue || []; renderLog(); }
    if (changes.assets) { assets = { sourceImages: [], ingredients: [], ...(changes.assets.newValue || {}) }; renderAssets(); }
  });
  setInterval(renderRunInfo, 1000);
}

function renderAll() {
  fillSettings();
  renderRunCard();
  renderAssets();
  renderQueue();
  renderLog();
}

// ---- Tabs ----
function bindTabs() {
  try { page = localStorage.getItem('page') || 'run'; } catch { /* ignore */ }
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => showPage(b.dataset.tab)));
  showPage(['run', 'settings', 'activity'].includes(page) ? page : 'run');
}

function showPage(name) {
  page = name;
  $$('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  $$('.page').forEach((p) => { p.hidden = p.id !== `page-${name}`; });
  try { localStorage.setItem('page', name); } catch { /* ignore */ }
  if (name === 'activity') {
    seenLog = log.length ? log[log.length - 1].t : 0;
    try { localStorage.setItem('seenLog', String(seenLog)); } catch { /* ignore */ }
  }
  renderLog();
}

// ---- Settings ----
function fillSettings() {
  $$('[data-setting]').forEach((el) => {
    const v = settings[el.dataset.setting];
    if (el.type === 'checkbox') el.checked = !!v;
    else if (document.activeElement !== el) el.value = v ?? '';
  });
  const sample = parsePrompts($('#prompts').value)[0] || queue[0]?.prompt || 'a red fox in the snow';
  const ext = expectsImages(settings.mode) ? 'png' : settings.saveText === 'txt' ? 'txt' : 'md';
  $('#filenamePreview').textContent = `Downloads/${buildFilename({ folder: settings.folder, index: 0, prompt: sample, ext, rename: settings.renameFiles })}`;
}

async function saveSettings(patch) {
  settings = normalizeSettings({ ...settings, ...patch });
  await chrome.storage.local.set({ settings });
  fillSettings();
}

function bindSettings() {
  $$('[data-setting]').forEach((el) => {
    el.addEventListener('change', () => {
      const key = el.dataset.setting;
      let value = el.type === 'checkbox' ? el.checked : el.value;
      if (el.type === 'number') value = Number(value);
      saveSettings({ [key]: value });
      renderRunCard();
    });
  });
}

// ---- Run card ----
function bindRun() {
  $$('#modes button').forEach((b) => b.addEventListener('click', () => {
    saveSettings({ mode: b.dataset.mode });
    renderRunCard();
    renderAssets();
  }));

  const box = $('#prompts');
  box.addEventListener('input', () => {
    chrome.storage.local.set({ draft: box.value });
    renderPromptCount();
  });
  $('#importFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const text = await file.text();
    const prompts = /\.csv$/i.test(file.name) ? parseCsvPrompts(text) : parsePrompts(text);
    box.value = [box.value.trim(), prompts.join('\n\n')].filter(Boolean).join('\n\n');
    chrome.storage.local.set({ draft: box.value });
    renderPromptCount();
  });

  $('#assetInput').addEventListener('change', async (e) => {
    const kind = assetKind(settings.mode);
    const files = [...e.target.files];
    e.target.value = '';
    if (!kind || !files.length) return;
    const read = await Promise.all(files.map((f) => new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve({ name: f.name, dataUrl: r.result });
      r.onerror = reject;
      r.readAsDataURL(f);
    })));
    assets[kind] = [...assets[kind], ...read];
    await chrome.storage.local.set({ assets });
    renderAssets();
  });
  $('#clearAssets').addEventListener('click', async () => {
    const kind = assetKind(settings.mode);
    if (!kind) return;
    assets[kind] = [];
    await chrome.storage.local.set({ assets });
    renderAssets();
  });

  $('#runBtn').addEventListener('click', onRun);
  $('#stopBtn').addEventListener('click', () => send('stop'));
  $('#recoverBtn').addEventListener('click', () => send('recover'));
  $('#newChatBtn').addEventListener('click', () => send('newChat'));
  $('#bannerAction').addEventListener('click', () => {
    if (run.pause === 'tooLong') send('newChat');
  });
}

async function onRun() {
  const btn = $('#runBtn');
  btn.disabled = true;
  const active = isActive();
  try {
    const prompts = parsePrompts($('#prompts').value);
    if (prompts.length) {
      if (settings.mode === MODES.IMAGE_TO_IMAGE && settings.imageMode !== 'last' && !assets.sourceImages.length) {
        flash('Add at least one source image for Image → Image.');
        return;
      }
      const res = await send('addPrompts', { prompts, mode: settings.mode });
      if (!res?.ok) {
        flash(`Could not add the prompts: ${res?.error || 'no answer from the extension'}`);
        return;
      }
      $('#prompts').value = '';
      await chrome.storage.local.set({ draft: '' });
      renderPromptCount();
    }
    if (active) return; // added to the running queue
    const res = await send('run');
    if (!res?.ok) flash(`Could not start: ${res?.error || 'no answer from the extension'}`);
  } finally {
    btn.disabled = false;
    renderRunCard();
  }
}

let flashTimer = null;
function flash(text) {
  const b = $('#banner');
  $('#bannerText').textContent = text;
  $('#bannerAction').hidden = true;
  b.hidden = false;
  b.classList.add('err');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { b.classList.remove('err'); renderRunCard(); }, 6000);
}

function renderPromptCount() {
  const n = parsePrompts($('#prompts').value).length;
  $('#promptCount').textContent = n ? `${n} prompt${n === 1 ? '' : 's'} ready` : '';
  const active = isActive();
  $('#runBtn').textContent = active ? (n ? `Add ${n} to queue` : 'Running…') : n ? `Add ${n} & Run` : 'Run';
  $('#runBtn').disabled = active && !n;
}

function renderRunCard() {
  $$('#modes button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === settings.mode)));
  $('#modeHint').textContent = MODE_HINTS[settings.mode];
  $$('[data-images-only]').forEach((el) => { el.style.visibility = expectsImages(settings.mode) ? '' : 'hidden'; });

  const state = run.state || 'idle';
  const pill = $('#statePill');
  pill.dataset.state = state;
  pill.textContent = STATE_LABELS[state] || state;
  const active = isActive();
  $('#stopBtn').disabled = !active || state === 'stopping';
  $('#recoverBtn').disabled = state !== 'running';
  renderPromptCount();

  // Chat line
  const link = $('#chatLink');
  if (settings.chatPolicy === 'perPrompt') {
    $('#chatText').textContent = 'Each prompt opens its own chat.';
    link.hidden = true;
    $('#newChatBtn').hidden = true;
  } else if (run.convId) {
    $('#chatText').textContent = 'All prompts go to this run\'s chat.';
    link.href = run.chatUrl || `https://chatgpt.com/c/${run.convId}`;
    link.hidden = false;
    $('#newChatBtn').hidden = false;
  } else {
    $('#chatText').textContent = settings.startIn === 'current' ? 'The first prompt goes into the chat open in ChatGPT; the rest follow it there.' : 'The first prompt opens a new chat; the rest follow it there.';
    link.hidden = true;
    $('#newChatBtn').hidden = true;
  }

  // Banner
  const banner = $('#banner');
  if (banner.classList.contains('err')) return;
  const action = $('#bannerAction');
  if (state === 'paused' && run.pause === 'tooLong') {
    banner.hidden = false;
    $('#bannerText').textContent = run.message || 'This chat is too long for ChatGPT.';
    action.textContent = 'Continue in a new chat';
    action.hidden = false;
  } else if (state === 'waitingNetwork') {
    banner.hidden = false;
    $('#bannerText').textContent = 'Connection lost. The run continues by itself when it comes back; nothing is skipped.';
    action.hidden = true;
  } else if (state === 'waitingLogin') {
    banner.hidden = false;
    $('#bannerText').textContent = 'Log in to ChatGPT in the ChatGPT tab. The run continues by itself.';
    action.hidden = true;
  } else {
    banner.hidden = true;
  }
  renderRunInfo();
}

function renderRunInfo() {
  const el = $('#runInfo');
  const current = queue.find((i) => i.id === run.currentId);
  if (run.state === 'running' && run.waitUntil > Date.now() && !current) {
    el.textContent = `Next prompt in ${Math.ceil((run.waitUntil - Date.now()) / 1000)} s`;
  } else if (run.state === 'running' && run.waitUntil > Date.now()) {
    el.textContent = `Waiting ${formatDuration(run.waitUntil - Date.now())} before retrying`;
  } else if (current && current.startedAt && ['running', 'waitingNetwork'].includes(run.state)) {
    el.textContent = `#${current.index + 1}: ${PHASES[current.phase] || 'Working'} · ${formatDuration(Date.now() - current.startedAt)}`;
  } else {
    el.textContent = '';
  }
}

function renderAssets() {
  const kind = assetKind(settings.mode);
  $('#assets').hidden = !kind;
  if (!kind) return;
  $('#assetsTitle').textContent = kind === 'ingredients' ? `Images (${assets[kind].length})` : `Source images (${assets[kind].length})`;
  $('#assetThumbs').replaceChildren(...assets[kind].map((a, idx) => {
    const div = document.createElement('div');
    div.className = 'thumb';
    const img = document.createElement('img');
    img.src = a.dataUrl;
    img.alt = a.name;
    const name = document.createElement('span');
    name.textContent = a.name;
    const rm = document.createElement('button');
    rm.textContent = '✕';
    rm.title = 'Remove';
    rm.addEventListener('click', async () => {
      assets[kind].splice(idx, 1);
      await chrome.storage.local.set({ assets });
      renderAssets();
    });
    div.append(img, name, rm);
    return div;
  }));
}

// ---- Queue ----
let clearArmed = 0;
function bindQueue() {
  $('#retryFailedBtn').addEventListener('click', () => send('retryFailed'));
  $('#resetBtn').addEventListener('click', () => send('resetQueue'));
  $('#clearBtn').addEventListener('click', () => {
    // Two clicks: browser confirm() dialogs don't reliably show in side panels.
    if (Date.now() > clearArmed) {
      clearArmed = Date.now() + 4000;
      renderQueue();
      setTimeout(renderQueue, 4100);
      return;
    }
    clearArmed = 0;
    send('clearQueue');
  });
  $('#queue').addEventListener('click', (e) => {
    const li = e.target.closest('.qi');
    if (!li) return;
    const id = li.dataset.id;
    if (e.target.closest('.qi-remove')) send('removeItem', { id });
    else if (e.target.closest('.qi-rerun')) send('rerunItem', { id });
    else if (e.target.closest('.qi-newchat')) send('toggleNewChat', { id });
    else if (e.target.closest('.qi-imagemode')) send('toggleImageMode', { id });
  });
}

function renderQueue() {
  const c = summarize(queue);
  const active = ['running', 'stopping', 'waitingNetwork', 'waitingLogin'].includes(run.state);
  $('#queueEmpty').hidden = queue.length > 0;
  $('#progressBar').style.width = `${c.percent}%`;
  $('#counts').textContent = queue.length ? `${c.completed}/${c.total} done${c.failed ? ` · ${c.failed} failed` : ''}${c.refused ? ` · ${c.refused} refused` : ''}` : '';
  $('#retryFailedBtn').disabled = !c.failed && !c.refused;
  $('#resetBtn').disabled = active || !c.done;
  $('#clearBtn').disabled = active || !queue.length;
  const armed = Date.now() < clearArmed && !active && queue.length;
  $('#clearBtn').textContent = armed ? 'Click again to clear' : 'Clear queue';
  $('#clearBtn').classList.toggle('danger', !!armed);

  const tpl = $('#itemTpl');
  const list = $('#queue');
  const prevScroll = list.scrollTop;
  list.replaceChildren(...queue.map((item) => {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = item.id;
    node.classList.add(item.status);
    node.querySelector('.qi-num').textContent = item.copies > 1 ? `${item.index + 1}.${item.copy + 1}` : `${item.index + 1}.`;
    const p = node.querySelector('.qi-prompt');
    p.textContent = item.prompt;
    p.title = item.output ? `${item.prompt}\n\n— ${item.output.slice(0, 600)}` : item.prompt;
    const chip = node.querySelector('.chip');
    chip.classList.add(item.status);
    const live = item.status === STATUS.RUNNING && item.id === run.currentId && PHASES[item.phase];
    chip.textContent = live || { queued: 'Queued', running: 'Running', completed: 'Done', failed: 'Failed', refused: 'Refused' }[item.status] || item.status;

    const thumbs = node.querySelector('.qi-thumbs');
    for (const src of item.thumbs || []) {
      const img = document.createElement('img');
      img.src = src;
      img.alt = '';
      thumbs.append(img);
    }

    const editable = item.status === STATUS.QUEUED;
    const nc = node.querySelector('.qi-newchat');
    nc.textContent = 'new chat here';
    nc.classList.toggle('on', !!item.newChat);
    nc.hidden = settings.chatPolicy === 'perPrompt' || (!editable && !item.newChat);
    nc.disabled = !editable;
    const im = node.querySelector('.qi-imagemode');
    im.textContent = 'last image';
    im.classList.toggle('on', item.imageMode === 'last');
    im.hidden = !expectsImages(item.mode) || (!editable && item.imageMode !== 'last');
    im.disabled = !editable;

    const extra = [];
    if (item.imageCount) extra.push(`${item.imageCount} image${item.imageCount > 1 ? 's' : ''}`);
    if (item.retries) extra.push(`retry ${item.retries}/${settings.maxRetries}`);
    if (item.finishedAt && item.startedAt) extra.push(formatDuration(item.finishedAt - item.startedAt));
    node.querySelector('.qi-extra').textContent = extra.join(' · ');
    const link = node.querySelector('.qi-link');
    if (item.chatUrl) { link.href = item.chatUrl; link.hidden = false; }
    node.querySelector('.qi-rerun').disabled = item.status === STATUS.RUNNING || item.status === STATUS.QUEUED;
    node.querySelector('.qi-remove').disabled = item.status === STATUS.RUNNING && active;
    const err = node.querySelector('.qi-error');
    if (item.error && item.status !== STATUS.COMPLETED && item.status !== STATUS.QUEUED) {
      err.textContent = item.error;
      err.hidden = false;
    }
    return node;
  }));
  list.scrollTop = prevScroll;
  renderRunInfo();
}

// ---- Activity ----
function bindActivity() {
  $('#clearLogBtn').addEventListener('click', () => send('clearLog'));
  $('#copyDiagBtn').addEventListener('click', copyDiagnostics);
}

function renderLog() {
  const ul = $('#log');
  const items = log.slice(-300).reverse();
  ul.replaceChildren(...items.map((e) => {
    const li = document.createElement('li');
    li.className = e.kind;
    const time = document.createElement('time');
    time.textContent = new Date(e.t).toLocaleTimeString();
    li.append(time, document.createTextNode(e.text));
    return li;
  }));
  if (page === 'activity' && log.length) {
    seenLog = log[log.length - 1].t;
    try { localStorage.setItem('seenLog', String(seenLog)); } catch { /* ignore */ }
  }
  const unseenErrors = log.filter((e) => e.t > seenLog && e.kind === 'error').length;
  const badge = $('#logBadge');
  badge.hidden = !unseenErrors;
  badge.textContent = String(unseenErrors);
}

async function copyDiagnostics() {
  const res = await send('diagnostics');
  const report = {
    extension: `bash-auto ${chrome.runtime.getManifest().version}`,
    userAgent: navigator.userAgent,
    run: { state: run.state, pause: run.pause, hasChat: !!run.convId },
    settings: {
      mode: settings.mode, chatPolicy: settings.chatPolicy, startIn: settings.startIn, imageWaitMin: settings.imageWaitMin,
      noImageQuietMin: settings.noImageQuietMin, maxRetries: settings.maxRetries, model: settings.model ? 'set' : '',
    },
    queue: summarize(queue),
    recentErrors: queue.filter((i) => i.error).slice(-8).map((i) => `#${i.index + 1} [${i.status}/${i.lastKind || '-'}]: ${i.error}`),
    page: res?.page || 'No ChatGPT tab answered.',
    log: log.slice(-80).map((e) => `${new Date(e.t).toISOString()} ${e.kind} ${e.text}`),
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
  const btn = $('#copyDiagBtn');
  btn.textContent = 'Copied';
  setTimeout(() => { btn.textContent = 'Copy diagnostics'; }, 2000);
}
