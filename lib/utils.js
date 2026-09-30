// Pure helpers shared by the side panel and the unit tests. No chrome.* usage here.

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Split raw user input into prompts.
 * - If the text contains a blank line, prompts are separated by blank lines
 *   (so a single prompt may span several lines).
 * - Otherwise every non-empty line is one prompt.
 */
export function parsePrompts(raw) {
  if (!raw) return [];
  const text = String(raw).replace(/\r\n?/g, '\n').trim();
  if (!text) return [];
  const parts = /\n\s*\n/.test(text) ? text.split(/\n\s*\n/) : text.split('\n');
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Parse a CSV file's text: uses the "prompt" column if present, else the first column. */
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
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

/** Random integer milliseconds between min and max seconds (inclusive, order-insensitive). */
export function randomDelay(minSec, maxSec, rand = Math.random) {
  let lo = Math.max(0, Number(minSec) || 0);
  let hi = Math.max(0, Number(maxSec) || 0);
  if (lo > hi) [lo, hi] = [hi, lo];
  return Math.round((lo + rand() * (hi - lo)) * 1000);
}

/** Filesystem-safe slug that keeps non-Latin letters (Vietnamese, CJK, Korean...). */
export function slugify(text, maxLen = 50) {
  const slug = String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\\/:*?"<>|#%&{}$!'`@+=~^\[\];,.()]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
  const cut = Array.from(slug).slice(0, maxLen).join('').replace(/^-+|-+$/g, '');
  return cut || 'output';
}

/** Sanitize a single folder name segment. */
export function safeFolder(name, fallback = 'default') {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/^\.+/, '')
    .trim()
    .replace(/\s+/g, ' ');
  return cleaned || fallback;
}

/**
 * Build a download path relative to the browser's Downloads folder.
 * ChatGPT-Automation/<project>/<NNN>-<slug>[-k].<ext>
 */
export function buildFilename({ project, index, prompt, ext, part, renameByPrompt = true }) {
  const num = String((index ?? 0) + 1).padStart(3, '0');
  const base = renameByPrompt ? `${num}-${slugify(prompt)}` : num;
  const suffix = part != null && part > 0 ? `-${part + 1}` : '';
  const extension = String(ext || 'txt').replace(/^\./, '');
  return `ChatGPT-Automation/${safeFolder(project)}/${base}${suffix}.${extension}`;
}

/** File name without extension, normalized for matching. */
export function fileStem(name) {
  return String(name || '').replace(/\.[^.]+$/, '').trim().toLowerCase();
}

/**
 * Ingredients mode: pick every reference image whose file stem appears in the prompt
 * as a whole word/phrase (case-insensitive). "_" and "-" in stems also match spaces.
 */
export function matchIngredientsByFilename(prompt, files) {
  const text = ` ${String(prompt || '').toLowerCase()} `;
  return (files || []).filter((f) => {
    const stem = fileStem(f.name);
    if (!stem) return false;
    const variants = new Set([stem, stem.replace(/[_-]+/g, ' ')]);
    for (const v of variants) {
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(v)}($|[^\\p{L}\\p{N}])`, 'iu');
      if (re.test(text)) return true;
    }
    return false;
  });
}

export function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Extension for a data URL or mime type. */
export function extFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('png')) return 'png';
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  if (m.includes('markdown')) return 'md';
  return 'bin';
}

export function mimeFromDataUrl(dataUrl) {
  const match = /^data:([^;,]+)/.exec(String(dataUrl || ''));
  return match ? match[1] : 'application/octet-stream';
}

/** Build the text-to-image prompt with an aspect-ratio instruction. */
export function withAspectRatio(prompt, ratio) {
  const labels = { '16:9': 'landscape 16:9', '9:16': 'portrait 9:16', '1:1': 'square 1:1' };
  const label = labels[ratio];
  if (!label) return prompt;
  return `${prompt}\n\nGenerate an image. Aspect ratio: ${label}.`;
}

export const STATUS = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  REFUSED: 'refused', // ChatGPT declined the prompt (e.g. content policy); skipped
});

export function summarize(queue) {
  const counts = { total: queue.length, queued: 0, running: 0, completed: 0, failed: 0, refused: 0 };
  for (const item of queue) counts[item.status] = (counts[item.status] || 0) + 1;
  counts.done = counts.completed + counts.failed + counts.refused;
  counts.percent = counts.total ? Math.round((counts.done / counts.total) * 100) : 0;
  return counts;
}
