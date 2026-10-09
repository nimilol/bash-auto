// Runs in chatgpt.com's own page world (manifest: "world": "MAIN", document_start), before the
// site's scripts. It watches the requests ChatGPT makes when a prompt is sent, which is how the
// extension knows a reply has finished: the reply stream closes. Nothing about the page's markup
// is involved, so redesigns of the page don't affect it.
//
// It also answers two kinds of requests from the extension's content script (agent.js), using the
// page's own login: read a conversation (/backend-api/conversation/<id>) and fetch a generated image.
//
// Talks to agent.js with window.postMessage: { cga: 'hook', … } out, { cga: 'agent', … } in.
(() => {
  if (window.__CGA_HOOK) return;
  window.__CGA_HOOK = true;
  const SSE = globalThis.CGA_SSE;
  const origFetch = window.fetch;
  const post = (msg) => window.postMessage({ cga: 'hook', ...msg }, location.origin);

  // ---- Headers ChatGPT sends to its backend, reused for the extension's own reads ------------
  const KEEP = ['authorization', 'oai-device-id', 'oai-language', 'oai-client-version'];
  let headers = {};
  let tokenAt = 0;

  function readHeaders(h) {
    const out = {};
    if (!h) return out;
    try {
      if (typeof h.forEach === 'function' && !Array.isArray(h)) h.forEach((v, k) => { out[k.toLowerCase()] = v; });
      else if (Array.isArray(h)) h.forEach(([k, v]) => { out[String(k).toLowerCase()] = v; });
      else Object.entries(h).forEach(([k, v]) => { out[k.toLowerCase()] = v; });
    } catch { /* unreadable */ }
    return out;
  }

  function remember(input, init) {
    const all = { ...readHeaders(input?.headers), ...readHeaders(init?.headers) };
    const kept = Object.fromEntries(KEEP.filter((k) => all[k]).map((k) => [k, all[k]]));
    if (kept.authorization) {
      headers = { ...headers, ...kept };
      tokenAt = Date.now();
    } else if (Object.keys(kept).length) headers = { ...kept, ...headers };
  }

  /** Headers for the extension's own backend reads; fetches a token when the page hasn't shown one. */
  async function authHeaders(refresh = false) {
    if (headers.authorization && !refresh && Date.now() - tokenAt < 10 * 60 * 1000) return headers;
    try {
      const res = await origFetch.call(window, '/api/auth/session', { credentials: 'include' });
      const json = await res.json();
      if (json?.accessToken) {
        headers = { ...headers, authorization: `Bearer ${json.accessToken}` };
        tokenAt = Date.now();
      }
    } catch { /* keep what we have */ }
    return headers;
  }

  // ---- Watching the reply streams -------------------------------------------------------------
  const CONVERSATION = /\/backend-api\/(?:f\/)?conversation(?:[/?]|$)/;
  let nextId = 0;

  function urlOf(input) {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.href;
    return input?.url || '';
  }

  function pathOf(url) {
    try { return new URL(url, location.href).pathname; } catch { return String(url); }
  }

  async function errorFromResponse(res) {
    try {
      const text = (await res.clone().text()).slice(0, 2000);
      try {
        const json = JSON.parse(text);
        const d = json.detail ?? json.error ?? json.message;
        return typeof d === 'string' ? d : JSON.stringify(d || json).slice(0, 300);
      } catch {
        return text.slice(0, 300);
      }
    } catch {
      return '';
    }
  }

  async function follow(sid, res, meta) {
    const sum = SSE.newSummary();
    sum.convId = meta.convId || '';
    let last = '';
    const update = () => {
      const key = `${sum.convId}|${sum.imageTask}|${sum.imagePointers}|${sum.error}|${sum.messages > 0}`;
      if (key === last) return;
      last = key;
      post({ t: 'update', sid, convId: sum.convId, imageTask: sum.imageTask, imagePointers: sum.imagePointers, error: sum.error, replying: sum.messages > 0 });
    };
    const parser = SSE.createParser((ev) => { SSE.summarize(sum, ev); update(); });
    let aborted = false;
    try {
      const reader = res.clone().body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.feed(decoder.decode(value, { stream: true }));
      }
      parser.end();
    } catch {
      aborted = true; // stopped by the page (Stop button, navigation) or the network
    }
    post({
      t: 'end', sid, status: res.status, aborted, convId: sum.convId, error: sum.error, done: sum.done,
      imageTask: sum.imageTask, imagePointers: sum.imagePointers, types: sum.types, events: sum.events,
    });
  }

  async function hookedFetch(input, init) {
    const url = urlOf(input);
    const path = pathOf(url);
    if (!path.includes('/backend-api/')) return origFetch.apply(window, arguments);
    remember(input, init);
    if (!CONVERSATION.test(path)) return origFetch.apply(window, arguments);

    const method = String(init?.method || input?.method || 'GET').toUpperCase();
    const meta = method === 'POST' ? SSE.readRequestBody(init?.body) : SSE.readRequestBody('');
    const sid = ++nextId;
    // A prompt being sent: announce it right away (the reply may take a while to start).
    let announced = false;
    if (meta.userText) {
      announced = true;
      post({ t: 'start', sid, path, method, userId: meta.userId, userText: meta.userText.slice(0, 4000), convId: meta.convId });
    }
    let res;
    try {
      res = await origFetch.apply(window, arguments);
    } catch (e) {
      if (announced) post({ t: 'end', sid, status: 0, aborted: true, error: String(e?.message || e).slice(0, 200), types: [], events: 0 });
      throw e;
    }
    const stream = /event-stream/i.test(res.headers.get('content-type') || '') && res.body;
    if (stream) {
      if (!announced) post({ t: 'start', sid, path, method, userId: '', userText: '', convId: meta.convId || convFromPath(path) });
      follow(sid, res, { convId: meta.convId || convFromPath(path) });
    } else if (announced) {
      // Not a stream: an error (rate limit, bad request…) or a format we don't know.
      const error = res.ok ? '' : (await errorFromResponse(res)) || `HTTP ${res.status}`;
      post({ t: 'end', sid, status: res.status, aborted: false, error, types: [], events: 0, notStream: true });
    }
    return res;
  }

  function convFromPath(path) {
    const m = /\/conversation\/([0-9a-f-]{16,})/i.exec(path);
    return m ? m[1] : '';
  }

  window.fetch = hookedFetch;

  // ---- Requests from the extension ------------------------------------------------------------
  async function getJson(path, retry = true) {
    const res = await origFetch.call(window, path, { credentials: 'include', headers: await authHeaders() });
    if ((res.status === 401 || res.status === 403) && retry) {
      await authHeaders(true);
      return getJson(path, false);
    }
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, status: res.status, data: await res.json() };
  }

  const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });

  /** Fetches a URL into a data: URL (null when the page isn't allowed to read it). */
  async function download(url) {
    let same = false;
    try { same = new URL(url, location.href).origin === location.origin; } catch { /* keep */ }
    for (const credentials of same ? ['include'] : ['omit', 'include']) {
      try {
        const res = await origFetch.call(window, url, same ? { credentials, headers: await authHeaders() } : { credentials });
        if (!res.ok) continue;
        const blob = await res.blob();
        if (blob.size && /^image\//.test(blob.type || 'image/')) return await blobToDataUrl(blob);
      } catch { /* next */ }
    }
    return null;
  }

  /** "file-service://file-abc" or "sediment://file_abc" -> the image as a data: URL, or its URL. */
  async function image({ pointer, convId }) {
    const fileId = String(pointer || '').replace(/^[a-z-]+:\/\//i, '');
    if (!fileId) return { ok: false, error: 'no file id' };
    const q = convId ? `?conversation_id=${encodeURIComponent(convId)}&inline=false` : '';
    const tries = [`/backend-api/files/download/${encodeURIComponent(fileId)}${q}`, `/backend-api/files/${encodeURIComponent(fileId)}/download`];
    for (const path of tries) {
      try {
        const res = await getJson(path);
        const url = res.ok && (res.data?.download_url || res.data?.url);
        if (!url) continue;
        const dataUrl = await download(url);
        return { ok: true, dataUrl, url: new URL(url, location.href).href };
      } catch { /* next */ }
    }
    return { ok: false, error: 'image download link not available' };
  }

  const OPS = {
    ping: async () => ({ ok: true }),
    conversation: ({ id }) => getJson(`/backend-api/conversation/${encodeURIComponent(id)}`),
    image,
  };

  window.addEventListener('message', async (e) => {
    const msg = e.data;
    if (e.source !== window || !msg || msg.cga !== 'agent' || !OPS[msg.op]) return;
    let reply;
    try {
      reply = await OPS[msg.op](msg.args || {});
    } catch (err) {
      reply = { ok: false, error: String(err?.message || err) };
    }
    post({ t: 'reply', id: msg.id, ...reply });
  });

  post({ t: 'ready' });
})();
