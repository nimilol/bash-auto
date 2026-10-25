// Pure helpers shared by the service worker, the panel and the unit tests. No extension APIs here.

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const MODES = Object.freeze({
  TEXT_TO_IMAGE: 'textToImage',
  IMAGE_TO_IMAGE: 'imageToImage',
  TEXT: 'text',
  INGREDIENTS: 'ingredients',
});

export const MODE_LIST = [MODES.TEXT_TO_IMAGE, MODES.IMAGE_TO_IMAGE, MODES.TEXT, MODES.INGREDIENTS];

export const expectsImages = (mode) => mode === MODES.TEXT_TO_IMAGE || mode === MODES.IMAGE_TO_IMAGE;

/** Which uploaded image list a mode uses (null when the mode takes no images). */
export const assetKind = (mode) => (mode === MODES.INGREDIENTS ? 'ingredients' : mode === MODES.IMAGE_TO_IMAGE ? 'sourceImages' : null);

export const STATUS = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  REFUSED: 'refused',
});

export const DEFAULT_SETTINGS = Object.freeze({
  mode: MODES.TEXT_TO_IMAGE,
  chatPolicy: 'same', // 'same': every prompt in one chat | 'perPrompt': a new chat for each prompt
  startIn: 'new', // first prompt of a run: 'new' chat | 'current' chat open in the ChatGPT tab
  aspectRatio: '',
  imageOutputs: 1,
  textOutputs: 1,
  imageMode: 'new', // 'new' | 'last' (send the previous generated image with the prompt)
  autoMatchImages: true,
  maxInputImages: 4,
  minDelay: 3,
  maxDelay: 8,
  maxRetries: 3,
  textTimeoutMin: 10,
  imageWaitMin: 30, // hard cap while ChatGPT still shows it's working on an image
  noImageQuietMin: 3, // nothing happening and no image for this long: no image is coming
  model: '',
  folder: 'ChatGPT-Images',
  renameFiles: true,
  saveImages: true,
  saveText: 'md', // 'none' | 'md' | 'txt'
  keepTabActive: true,
});

/** Settings merged over the defaults, with every number clamped to a sane range. */
export function normalizeSettings(raw = {}) {
  const s = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  const num = (v, lo, hi, def) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
  };
  s.mode = MODE_LIST.includes(s.mode) ? s.mode : DEFAULT_SETTINGS.mode;
  s.chatPolicy = s.chatPolicy === 'perPrompt' ? 'perPrompt' : 'same';
  s.startIn = s.startIn === 'current' ? 'current' : 'new';
  s.imageMode = s.imageMode === 'last' ? 'last' : 'new';
  s.aspectRatio = ['', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'].includes(s.aspectRatio) ? s.aspectRatio : '';
  s.imageOutputs = Math.round(num(s.imageOutputs, 1, 50, 1));
  s.textOutputs = Math.round(num(s.textOutputs, 1, 10, 1));
  s.maxInputImages = Math.round(num(s.maxInputImages, 1, 10, 4));
  s.minDelay = num(s.minDelay, 0, 3600, 3);
  s.maxDelay = num(s.maxDelay, 0, 3600, 8);
  if (s.maxDelay < s.minDelay) s.maxDelay = s.minDelay;
  s.maxRetries = Math.round(num(s.maxRetries, 0, 20, 3));
  s.textTimeoutMin = num(s.textTimeoutMin, 0.1, 120, 10);
  s.imageWaitMin = num(s.imageWaitMin, 0.1, 240, 30);
  s.noImageQuietMin = num(s.noImageQuietMin, 0.05, 60, 3);
  s.model = String(s.model || '').trim();
  s.folder = safeFolder(s.folder, DEFAULT_SETTINGS.folder);
  s.renameFiles = s.renameFiles !== false;
  s.saveImages = s.saveImages !== false;
  s.saveText = ['none', 'md', 'txt'].includes(s.saveText) ? s.saveText : 'md';
  s.keepTabActive = s.keepTabActive !== false;
  return s;
}

/**
 * Split raw input into prompts. With a blank line anywhere, prompts are separated by blank lines
 * (one prompt may span several lines). Otherwise each non-empty line is a prompt.
 */
export function parsePrompts(raw) {
  const text = String(raw || '').replace(/\r\n?/g, '\n').trim();
  if (!text) return [];
  const parts = /\n\s*\n/.test(text) ? text.split(/\n\s*\n/) : text.split('\n');
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Prompts from a CSV file: the "prompt" column when there is one, else the first column. */
export function parseCsvPrompts(raw) {
  const rows = parseCsv(String(raw || ''));
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  let col = header.indexOf('prompt');
  let body = rows;
  if (col !== -1) body = rows.slice(1);
  else col = 0;
  return body.map((r) => (r[col] || '').trim()).filter(Boolean);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f.trim())) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim())) rows.push(row);
  return rows;
}

/** Random wait in ms between min and max seconds. */
export function randomDelay(minSec, maxSec, rand = Math.random) {
  let lo = Math.max(0, Number(minSec) || 0);
  let hi = Math.max(0, Number(maxSec) || 0);
  if (lo > hi) [lo, hi] = [hi, lo];
  return Math.round((lo + rand() * (hi - lo)) * 1000);
}

/** File-name-safe slug that keeps letters of any script. */
export function slugify(text, maxLen = 60) {
  const slug = String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\\/:*?"<>|#%&{}$!'`@+=~^[\];,.()]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
  const cut = Array.from(slug).slice(0, maxLen).join('').replace(/^-+|-+$/g, '');
  return cut || 'output';
}

/** One folder name, safe for the Downloads folder. */
export function safeFolder(name, fallback = 'ChatGPT-Images') {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || fallback;
}

/**
 * Path inside the Downloads folder: <folder>/<NNN>-<slug>[-v<copy>][-<part>].<ext>
 * copy: which output of the prompt (Outputs per prompt > 1); part: which image of one reply.
 */
export function buildFilename({ folder, index, prompt, ext, copy, part, rename = true }) {
  const num = String((index ?? 0) + 1).padStart(3, '0');
  const base = rename ? `${num}-${slugify(prompt)}` : num;
  const variant = copy > 0 ? `-v${copy + 1}` : '';
  const suffix = part > 0 ? `-${part + 1}` : '';
  return `${safeFolder(folder)}/${base}${variant}${suffix}.${String(ext || 'png').replace(/^\./, '')}`;
}

export function extFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('png')) return 'png';
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  return 'png';
}

export function mimeFromDataUrl(dataUrl) {
  const m = /^data:([^;,]+)/.exec(String(dataUrl || ''));
  return m ? m[1] : '';
}

/** Image extension from a URL's path (png when it doesn't say). */
export function extFromUrl(url) {
  try {
    const m = /\.(png|jpe?g|webp|gif)$/i.exec(new URL(url).pathname);
    if (m) return m[1].toLowerCase().replace('jpeg', 'jpg');
  } catch { /* not a URL */ }
  return 'png';
}

export function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const stem = (name) => String(name || '').replace(/\.[^.]+$/, '').trim().toLowerCase();

/** Uploaded images whose file name (without extension) appears in the prompt as a word or phrase. */
export function matchImagesByName(prompt, files) {
  const text = ` ${String(prompt || '').toLowerCase()} `;
  return (files || []).filter((f) => {
    const s = stem(f.name);
    if (!s) return false;
    return [s, s.replace(/[_-]+/g, ' ')].some((v) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(v)}($|[^\\p{L}\\p{N}])`, 'iu').test(text));
  });
}

const RATIO_LABELS = {
  '1:1': 'square 1:1', '16:9': 'landscape 16:9', '9:16': 'portrait 9:16', '4:3': 'landscape 4:3', '3:4': 'portrait 3:4', '3:2': 'landscape 3:2', '2:3': 'portrait 2:3',
};

/** The prompt with an aspect-ratio line added (unchanged when no ratio is set). */
export function withAspectRatio(prompt, ratio) {
  const label = RATIO_LABELS[ratio];
  return label ? `${prompt}\n\nAspect ratio: ${label}.` : prompt;
}

/**
 * What to send for one queue item: { prompt, files, expectImages }.
 * assets: { sourceImages:[{name,dataUrl}], ingredients:[{name,dataUrl}] }; previousImage: {name,dataUrl}|null
 */
export function buildRequest(item, settings, assets = {}, previousImage = null, promptCount = 0) {
  const mode = item.mode || settings.mode;
  let prompt = item.prompt;
  let files = [];
  const max = Math.max(1, Math.round(Number(settings.maxInputImages)) || 4);
  const chained = item.imageMode === 'last' && previousImage;
  switch (mode) {
    case MODES.TEXT_TO_IMAGE:
      if (chained) files = [previousImage];
      prompt = withAspectRatio(prompt, settings.aspectRatio);
      break;
    case MODES.IMAGE_TO_IMAGE: {
      if (chained) files = [previousImage];
      else {
        const src = assets.sourceImages || [];
        const matched = settings.autoMatchImages ? matchImagesByName(prompt, src) : [];
        if (matched.length) files = matched;
        // As many images as prompts: one each, in order. Otherwise every image goes with every prompt.
        else if (src.length > 1 && src.length >= promptCount) files = [src[item.index % src.length]];
        else files = src;
        if (!files.length) throw new Error('Image to Image needs at least one source image');
      }
      prompt = withAspectRatio(prompt, settings.aspectRatio);
      break;
    }
    case MODES.INGREDIENTS: {
      const all = assets.ingredients || [];
      files = settings.autoMatchImages ? matchImagesByName(prompt, all) : all;
      break;
    }
    default:
      break;
  }
  return { prompt, files: files.slice(0, max), expectImages: expectsImages(mode) };
}

/** Queue items for prompts: one per output wanted. */
export function makeItems(prompts, { mode, firstIndex = 0, outputs = 1, imageMode = 'new' }, newId = () => crypto.randomUUID()) {
  const copies = Math.min(50, Math.max(1, Math.round(Number(outputs)) || 1));
  const items = [];
  prompts.forEach((prompt, n) => {
    for (let copy = 0; copy < copies; copy++) {
      items.push({
        id: newId(),
        index: firstIndex + n,
        copy,
        copies,
        prompt,
        mode,
        imageMode: expectsImages(mode) ? imageMode : 'new',
        newChat: false, // per-prompt override: start a new chat at this prompt
        status: STATUS.QUEUED,
        retries: 0,
        interruptions: 0,
        refusals: 0,
        error: '',
      });
    }
  });
  return items;
}

/** "#3", or "#3 (2/4)" when a prompt has several outputs. */
export function itemLabel(item) {
  const n = `#${(item?.index ?? 0) + 1}`;
  return item?.copies > 1 ? `${n} (${item.copy + 1}/${item.copies})` : n;
}

export function summarize(queue) {
  const c = { total: queue.length, queued: 0, running: 0, completed: 0, failed: 0, refused: 0 };
  for (const item of queue) c[item.status] = (c[item.status] || 0) + 1;
  c.done = c.completed + c.failed + c.refused;
  c.percent = c.total ? Math.round((c.done / c.total) * 100) : 0;
  return c;
}

/** Conversation id from a chatgpt.com URL ("/c/<id>", also inside project and GPT paths), or ''. */
export function conversationId(url) {
  const m = /\/c\/([0-9a-f][\w-]{7,})/i.exec(String(url || ''));
  return m ? m[1] : '';
}

export const CHAT_ORIGINS = ['https://chatgpt.com', 'https://chat.openai.com'];
export const isChatUrl = (url) => CHAT_ORIGINS.some((o) => String(url || '').startsWith(`${o}/`) || String(url || '') === o);

/** Same origin as `like` (chatgpt.com by default), path /c/<id>. */
export function chatUrlFor(convId, like = 'https://chatgpt.com/') {
  let origin = 'https://chatgpt.com';
  try { if (isChatUrl(like)) origin = new URL(like).origin; } catch { /* default */ }
  return convId ? `${origin}/c/${convId}` : `${origin}/`;
}

/**
 * Where the next prompt goes. Pure, so the single-chat rule is unit-tested.
 * Returns { kind: 'chat', convId } | { kind: 'new' } | { kind: 'current' }.
 *  - A prompt that already reached a chat (interrupted) always goes back to that chat.
 *  - "New chat here" on the prompt, or the per-prompt policy: a new chat.
 *  - Otherwise the run's chat; for the first prompt of a run, a new chat or the open chat.
 */
export function chooseChat(item, run, settings) {
  if (item.convId) return { kind: 'chat', convId: item.convId };
  if (item.newChat || settings.chatPolicy === 'perPrompt') return { kind: 'new' };
  if (run.convId) return { kind: 'chat', convId: run.convId };
  return settings.startIn === 'current' ? { kind: 'current' } : { kind: 'new' };
}

export function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
