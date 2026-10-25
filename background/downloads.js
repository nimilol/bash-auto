// Saves a finished prompt's files into Downloads/<folder>/.
// Service workers can't create blob: URLs, and a data: URL over ~2 MB is too long for the
// downloads API, so images are turned into blob: URLs by a small offscreen document. If that
// isn't possible, the image's own https address is downloaded instead (with the browser's cookies).
import { outputsFor } from './engine.js';

const OFFSCREEN = 'offscreen/offscreen.html';
let creating = null;

async function ensureOffscreen() {
  if (!chrome.offscreen) return false;
  try {
    const contexts = await chrome.runtime.getContexts?.({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (contexts?.length) return true;
  } catch { /* older Chrome: just try to create it */ }
  if (!creating) {
    creating = chrome.offscreen.createDocument({ url: OFFSCREEN, reasons: ['BLOBS'], justification: 'Save generated images and replies as files' })
      .catch((e) => { if (!/single offscreen|already/i.test(String(e?.message))) throw e; })
      .finally(() => { creating = null; });
  }
  await creating;
  return true;
}

/** A blob: URL for data (data: URL or text), made in the offscreen document. */
async function blobUrl(payload) {
  if (!(await ensureOffscreen())) return '';
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'MAKE_BLOB_URL', ...payload }).catch(() => null);
  return res?.url || '';
}

async function download(url, filename) {
  const id = await chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });
  if (id == null) throw new Error(chrome.runtime.lastError?.message || 'download refused');
  return id;
}

/** Saves every output of the item. log(kind, text) reports each file. */
export async function saveOutputs(item, result, settings, log) {
  for (const file of outputsFor(item, result, settings)) {
    const tries = [];
    if (file.data) {
      tries.push(async () => blobUrl({ dataUrl: file.data }));
      if (file.data.length < 1.9 * 1024 * 1024) tries.push(async () => file.data);
    }
    if (file.url) tries.push(async () => file.url);
    if (file.text != null) {
      tries.push(async () => blobUrl({ text: file.text, mime: `${file.mime};charset=utf-8` }));
      tries.push(async () => `data:${file.mime};charset=utf-8,${encodeURIComponent(file.text)}`);
    }
    let saved = false;
    let lastError = '';
    for (const get of tries) {
      try {
        const url = await get();
        if (!url) continue;
        await download(url, file.filename);
        saved = true;
        break;
      } catch (e) {
        lastError = String(e?.message || e);
      }
    }
    if (saved) log('info', `Saved ${file.filename}`);
    else log('error', `Could not save ${file.filename}${lastError ? `: ${lastError}` : ''}`);
  }
}
