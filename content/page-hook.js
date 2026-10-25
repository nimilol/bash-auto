// Runs in chatgpt.com's own page world (manifest "world": "MAIN", document_start), before the
// site's scripts. It sees the requests ChatGPT makes when a prompt is sent: when the reply stream
// opens and closes, whether it failed, and whether it started an image. ChatGPT's push messages
// (WebSocket) only trigger an early re-read of the conversation.
//
// It also serves the content script (agent.js), using the page's own login:
//   conversation  read /backend-api/conversation/<id>
//   image         turn an image pointer (sediment://…, file-service://…) into image data
//   probe         is chatgpt.com reachable right now?
// Messages: window.postMessage { cga: 'hook', … } out, { cga: 'agent', … } in.
(() => {
  if (window.__CGA_HOOK) return;
  window.__CGA_HOOK = true;
  const SSE = globalThis.CGA_SSE;
  const origFetch = window.fetch;
  const post = (msg) => window.postMessage({ cga: 'hook', ...msg }, location.origin);

  // ---- The headers ChatGPT sends to its backend, reused for the extension's own reads ---------
  const KEEP = ['authorization', 'oai-device-id', 'oai-language', 'oai-client-version', 'chatgpt-account-id'];
  let headers = {};
  let tokenAt = 0;

  function readHeaders(h) {
    const out = {};
    if (!h) return out;
    try {
      if (typeof h.forEach === 'function' && !Array.isArray(h)) h.forEach((v, k) => { out[String(k).toLowerCase()] = v; });
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

  async function authHeaders(refresh = false) {
    if (headers.authorization && !refresh && Date.now() - tokenAt < 10 * 60 * 1000) return headers;
    try {
      const res = await origFetch.call(window, '/api/auth/session', { credentials: 'include', cache: 'no-store' });
      const json = await res.json();
      if (json?.accessToken) {
        headers = { ...headers, authorization: `Bearer ${json.accessToken}` };
        tokenAt = Date.now();
      }
    } catch { /* keep what we have */ }
    return headers;
  }

  // ---- Reply streams ---------------------------------------------------------------------------
  const CONVERSATION = /\/backend-api\/(?:f\/)?conversation(?:[/?]|$)/;
  let nextId = 0;

  const urlOf = (input) => (typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url || '');
  const pathOf = (url) => {
    try { return new URL(url, location.href).pathname; } catch { return String(url); }
  };
  const convFromPath = (path) => (/\/conversation\/([0-9a-f][\w-]{15,})/i.exec(path) || [])[1] || '';

  async function errorFromResponse(res) {
    try {
      const text = (await res.clone().text()).slice(0, 4000);
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

  async function follow(sid, res, convId) {
    const sum = SSE.newSummary();
    sum.convId = convId || '';
    let last = '';
    const update = () => {
      const key = `${sum.convId}|${sum.imageTask}|${sum.imagePointers}|${sum.error}|${sum.messages > 0}`;
      if (key === last) return;
      last = key;
      post({ t: 'update', sid, convId: sum.convId, imageTask: sum.imageTask, imagePointers: sum.imagePointers, error: sum.error, replying: sum.messages > 0 });
    };
    const parser = SSE.createParser((ev) => { SSE.summarize(sum, ev); update(); });
    let aborted = false;
    let abortError = '';
    try {
      const reader = res.clone().body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.feed(decoder.decode(value, { stream: true }));
      }
      parser.end();
    } catch (e) {
      aborted = true; // Stop button, navigation, or the connection dropped
      abortError = String(e?.name === 'AbortError' ? 'aborted' : e?.message || e).slice(0, 200);
    }
    post({
      t: 'end', sid, status: res.status, aborted, abortError, offline: navigator.onLine === false,
      convId: sum.convId, error: sum.error, tooLong: sum.tooLong, done: sum.done,
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
    const meta = SSE.readRequestBody(method === 'POST' ? init?.body : '');
    const sid = ++nextId;
    let announced = false;
    if (meta.userText) {
      announced = true;
      post({ t: 'start', sid, path, userId: meta.userId, userText: meta.userText.slice(0, 4000), convId: meta.convId });
    }
    let res;
    try {
      res = await origFetch.apply(window, arguments);
    } catch (e) {
      if (announced) {
        const error = String(e?.message || e).slice(0, 200);
        post({ t: 'end', sid, status: 0, aborted: true, abortError: error, offline: navigator.onLine === false, network: e?.name !== 'AbortError', types: [], events: 0 });
      }
      throw e;
    }
    const stream = /event-stream/i.test(res.headers.get('content-type') || '') && res.body;
    if (stream) {
      const convId = meta.convId || convFromPath(path);
      if (!announced) post({ t: 'start', sid, path, userId: '', userText: '', convId });
      follow(sid, res, convId);
    } else if (announced) {
      const error = res.ok ? '' : (await errorFromResponse(res)) || `HTTP ${res.status}`;
      post({ t: 'end', sid, status: res.status, aborted: false, error, tooLong: SSE.isTooLong(error), types: [], events: 0, notStream: true });
    }
    return res;
  }
  window.fetch = hookedFetch;

  // ---- Push messages: only used as "re-read the conversation now" ------------------------------
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  const OrigWS = window.WebSocket;
  if (OrigWS) {
    let lastPing = 0;
    const onMessage = (e) => {
      if (typeof e.data !== 'string' || e.data.length > 300000) return;
      const now = Date.now();
      if (now - lastPing < 500) return;
      const ids = [...new Set(e.data.match(UUID) || [])].slice(0, 8);
      if (!ids.length) return;
      lastPing = now;
      post({ t: 'push', ids });
    };
    const Hooked = function WebSocket(...args) {
      const ws = new OrigWS(...args);
      try { ws.addEventListener('message', onMessage); } catch { /* ignore */ }
      return ws;
    };
    Hooked.prototype = OrigWS.prototype;
    for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Hooked[k] = OrigWS[k];
    window.WebSocket = Hooked;
  }

  // ---- Requests from the extension ------------------------------------------------------------
  const isNetErr = (e) => e instanceof TypeError || SSE.isNetworkError(e?.message);

  async function getJson(path, retry = true) {
    let res;
    try {
      res = await origFetch.call(window, path, { credentials: 'include', cache: 'no-store', headers: await authHeaders() });
    } catch (e) {
      return { ok: false, network: isNetErr(e), error: String(e?.message || e).slice(0, 200) };
    }
    if ((res.status === 401 || res.status === 403) && retry) {
      await authHeaders(true);
      return getJson(path, false);
    }
    if (!res.ok) return { ok: false, status: res.status };
    try {
      return { ok: true, status: res.status, data: await res.json() };
    } catch (e) {
      return { ok: false, status: res.status, network: isNetErr(e), error: 'bad JSON' };
    }
  }

  const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });

  /** A URL's image as a data: URL, or null when the page can't read it. */
  async function fetchImage(url) {
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

  async function image({ pointer, convId }) {
    const fileId = String(pointer || '').replace(/^[a-z-]+:\/\//i, '');
    if (!fileId) return { ok: false, error: 'no file id' };
    const q = convId ? `?conversation_id=${encodeURIComponent(convId)}&inline=false` : '';
    let network = false;
    for (const path of [`/backend-api/files/download/${encodeURIComponent(fileId)}${q}`, `/backend-api/files/${encodeURIComponent(fileId)}/download`]) {
      const res = await getJson(path);
      if (res.network) network = true;
      const url = res.ok && (res.data?.download_url || res.data?.url);
      if (!url) continue;
      const dataUrl = await fetchImage(url);
      if (dataUrl) return { ok: true, dataUrl, url: new URL(url, location.href).href };
    }
    return { ok: false, network, error: 'image download link not available' };
  }

  async function probe() {
    if (navigator.onLine === false) return { ok: true, online: false };
    try {
      const res = await origFetch.call(window, `/api/auth/session?_=${Date.now()}`, { credentials: 'include', cache: 'no-store' });
      return { ok: true, online: true, status: res.status };
    } catch (e) {
      return { ok: true, online: false, error: String(e?.message || e).slice(0, 120) };
    }
  }

  const OPS = {
    ping: async () => ({ ok: true }),
    conversation: ({ id }) => getJson(`/backend-api/conversation/${encodeURIComponent(id)}`),
    image,
    probe,
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
