// Content script for chatgpt.com: types and sends prompts, and reports when each reply is done.
//
// How a prompt is followed (a "job"):
//  1. CGA_SUBMIT starts the job and answers at once. Typing, attaching and sending happen in the
//     background; the panel follows along with CGA_POLL every second or two.
//  2. Every poll moves the job forward. The panel's polls are the clock, not this page's timers,
//     which the browser slows down when the tab is in the background.
//  3. The reply is finished when ChatGPT's reply stream has closed (seen by net-hook.js) and the
//     conversation, read from ChatGPT's own backend, shows the final message. Text and images come
//     from that conversation too, so no part of this depends on the page's markup.
//  4. Only if the conversation can't be read (not logged in, ChatGPT changed its backend) does the job
//     fall back to watching the page: Stop button, reply text settling, images appearing.
// Classic script, guarded so injecting it twice is harmless.
(() => {
  if (globalThis.__CGA_AGENT) return;

  const ext = globalThis.browser?.runtime?.onMessage ? globalThis.browser : globalThis.chrome;
  const S = () => globalThis.CGA_SELECTORS;
  const L = () => globalThis.CGA_LABELS;
  const CONV = () => globalThis.CGA_CONV;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const NET_WAIT_MS = 20000; // no conversation id this long after sending: watch the page instead
  const JSON_EVERY_MS = 2500; // how often the conversation is re-read while waiting
  const SETTLE_MS = 45000; // nothing changes for this long and nothing is streaming: finished
  const IMAGE_GRACE_MS = 15000; // a finished reply without an image gets this long for one to show up
  const NO_PROMPT_MS = 90000; // the prompt never shows up in the conversation: it was lost
  const STALL_MS = 3 * 60 * 1000; // no sign of life for this long: ChatGPT stopped responding
  const STREAM_PEEK_MS = 10000; // while a stream is open, look at the conversation this often
  const OPEN_STREAM_DONE_MS = 30000; // a finished reply whose stream stays open this long is done

  function fail(message, stage) {
    const e = new Error(message);
    e.stage = stage;
    return e;
  }

  const normalize = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const flat = (s) => normalize(s).toLowerCase().replace(/[‘’ʼ]/g, "'");

  // ---- Bridge to net-hook.js (the page's world) -----------------------------------------------

  /** Reply streams seen on this page, newest last. */
  const streams = [];
  let hookReady = false;
  let callId = 0;
  const calls = new Map();

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (e.source !== window || !m || m.cga !== 'hook') return;
    hookReady = true;
    if (m.t === 'start') {
      streams.push({
        sid: m.sid, path: m.path, method: m.method, userId: m.userId || '', userText: m.userText || '', convId: m.convId || '',
        startedAt: Date.now(), endedAt: 0, imageTask: false, imagePointers: 0, error: '', status: 0, types: [], replying: false,
      });
      if (streams.length > 40) streams.shift();
    } else if (m.t === 'update' || m.t === 'end') {
      const s = streams.find((x) => x.sid === m.sid);
      if (!s) return;
      if (m.convId) s.convId = m.convId;
      s.imageTask = s.imageTask || !!m.imageTask;
      s.imagePointers = Math.max(s.imagePointers, m.imagePointers || 0);
      if (m.error) s.error = m.error;
      if (m.replying) s.replying = true;
      if (m.t === 'end') Object.assign(s, { endedAt: Date.now(), status: m.status, aborted: !!m.aborted, types: m.types || [], events: m.events || 0 });
    } else if (m.t === 'reply') {
      const done = calls.get(m.id);
      calls.delete(m.id);
      done?.(m);
    }
  });

  /** Ask net-hook.js to do something with the page's login. Resolves { ok, … }, never rejects. */
  function call(op, args = {}, timeout = 20000) {
    return new Promise((resolve) => {
      const id = ++callId;
      calls.set(id, resolve);
      window.postMessage({ cga: 'agent', id, op, args }, location.origin);
      setTimeout(() => {
        if (!calls.has(id)) return;
        calls.delete(id);
        resolve({ ok: false, error: hookReady ? 'timed out' : 'page hook not loaded' });
      }, timeout);
    });
  }
  call('ping', {}, 5000);

  const liveStreams = () => streams.filter((s) => !s.endedAt);

  // ---- Page helpers (sending, and the fallback that watches the page) -------------------------

  function q(list, root = document) {
    for (const sel of [].concat(list)) {
      const el = root.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function qa(list, root = document) {
    const out = new Set();
    for (const sel of [].concat(list)) root.querySelectorAll(sel).forEach((el) => out.add(el));
    return [...out];
  }

  const outermost = (els) => els.filter((el) => !els.some((o) => o !== el && o.contains(el)));

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  async function waitFor(fn, { timeout = 30000, interval = 250, label = 'condition', stage } = {}) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(interval);
    }
    throw fail(`Timed out waiting for ${label}`, stage);
  }

  function composer() {
    for (const sel of S().composer) {
      const all = [...document.querySelectorAll(sel)];
      const el = all.find(visible) || all[0];
      if (el) return el;
    }
    return null;
  }

  const composerText = (el) => (el.tagName === 'TEXTAREA' ? el.value : el.innerText);

  function composerArea() {
    const el = composer();
    if (!el) return null;
    const form = el.closest('form');
    if (form) return form;
    let node = el;
    for (let i = 0; i < 5 && node.parentElement; i++) node = node.parentElement;
    return node;
  }

  const label = (btn) => flat(btn.getAttribute('aria-label') || btn.getAttribute('title') || btn.innerText || '');

  function hasStopIcon(btn) {
    const svg = btn.querySelector('svg');
    if (!svg) return false;
    if (svg.querySelector('use[href*="stop" i]')) return true;
    const shapes = svg.querySelectorAll('path, rect, circle, line, polygon, polyline, ellipse');
    if (shapes.length !== 1) return false;
    if (shapes[0].tagName.toLowerCase() === 'rect') return true;
    const d = (shapes[0].getAttribute('d') || '').trim();
    return S().stopIconPaths.some((p) => d.startsWith(p));
  }

  /** 'stop' | 'send' | 'other': test id, then label (any language), then icon, then type. */
  function buttonKind(btn) {
    const id = (btn.getAttribute('data-testid') || '').toLowerCase();
    if (id.includes('stop')) return 'stop';
    if (/speech|voice|dictat|mic/.test(id)) return 'other';
    if (id.includes('send')) return 'send';
    const text = label(btn);
    if (text && L().stop.some((w) => text.includes(w))) return 'stop';
    if (text && L().send.some((w) => text.includes(w))) return 'send';
    if (hasStopIcon(btn)) return 'stop';
    if ((btn.getAttribute('type') || '').toLowerCase() === 'submit') return 'send';
    return 'other';
  }

  function controlCandidates() {
    const area = composerArea();
    const known = qa([...S().submitSlot, ...S().sendButton, ...S().stopButton]);
    const local = area ? [...area.querySelectorAll('button')] : [];
    return [...new Set([...known, ...local])].filter(visible);
  }

  const findStop = () => qa(S().stopButton).find(visible) || controlCandidates().find((b) => buttonKind(b) === 'stop') || null;
  const findSend = () => controlCandidates().find((b) => buttonKind(b) === 'send') || null;
  const enabled = (b) => !!b && !b.disabled && b.getAttribute('aria-disabled') !== 'true';

  function turns() {
    for (const sel of S().turn) {
      const els = outermost([...document.querySelectorAll(sel)]);
      if (els.length) return els;
    }
    return outermost(qa([S().userMessage, S().assistantMessage]));
  }

  function roleOf(turn) {
    const own = turn.getAttribute('data-turn') || turn.getAttribute('data-message-author-role');
    if (own === 'user' || own === 'assistant') return own;
    if (turn.querySelector(S().userMessage)) return 'user';
    if (turn.querySelector(S().assistantMessage)) return 'assistant';
    return null;
  }

  function isReplyLike(turn) {
    const role = roleOf(turn);
    if (role) return role === 'assistant';
    return !!q(S().markdown, turn);
  }

  function showsPrompt(turn, prompt) {
    if (isReplyLike(turn)) return false;
    const head = flat(prompt).slice(0, 80);
    return !!head && flat(turn.innerText).includes(head);
  }

  /** The turns after the latest turn showing the prompt. */
  function replyTurns(prompt) {
    const list = turns();
    let at = -1;
    for (let i = list.length - 1; i >= 0; i--) if (showsPrompt(list[i], prompt)) { at = i; break; }
    if (at === -1) return [];
    return list.slice(at + 1).filter((t) => roleOf(t) !== 'user');
  }

  function textOf(list) {
    return list
      .map((t) => {
        const mds = outermost(qa(S().markdown, t));
        if (mds.length) return mds.map((m) => m.innerText.trim()).filter(Boolean).join('\n\n');
        const clone = t.cloneNode(true);
        clone.querySelectorAll('button, [role="button"], svg').forEach((b) => b.remove());
        return clone.innerText.trim();
      })
      .filter(Boolean)
      .join('\n\n');
  }

  function hasActionBar(list) {
    return list.some((t) => q(S().actionBar, t)
      || [...t.querySelectorAll('button')].some((b) => {
        const text = label(b);
        return text && L().copy.some((w) => text.includes(w));
      }));
  }

  const srcOf = (img) => img.currentSrc || img.src || '';

  function isPreview(img) {
    let node = img;
    for (let i = 0; i < 4 && node && node !== document.body; i++, node = node.parentElement) {
      const style = getComputedStyle(node);
      if (Number(style.opacity) === 0) return true;
      const blur = /blur\(\s*([\d.]+)/.exec(style.filter || '');
      if (blur && Number(blur[1]) > 0) return true;
    }
    return false;
  }

  function finishedImages(imgs) {
    const seen = new Set();
    return imgs.filter((img) => {
      const src = srcOf(img);
      if (!src || seen.has(src)) return false;
      const big = (img.naturalWidth || img.width) >= 200 || (img.naturalHeight || img.height) >= 200;
      if (!big || !img.complete || isPreview(img)) return false;
      seen.add(src);
      return true;
    });
  }

  function conversationImages() {
    const root = document.querySelector('main') || document.body;
    const area = composerArea();
    return [...root.querySelectorAll('img')].filter((img) => !area?.contains(img));
  }

  /** Images in the reply turns, else any image that appeared since the job started. */
  function domImages(job) {
    const reply = replyTurns(job.prompt);
    const own = finishedImages(reply.flatMap((t) => qa(S().generatedImage, t)));
    if (own.length) return own;
    const users = turns().filter((t) => roleOf(t) === 'user' || showsPrompt(t, job.prompt) || (job.nudgeText && showsPrompt(t, job.nudgeText)));
    return finishedImages(conversationImages().filter((img) => !job.baseline.has(srcOf(img)) && !users.some((t) => t.contains(img))));
  }

  function pageError(list) {
    const scopes = [...list, ...qa(S().errorBanner)].filter(Boolean);
    for (const scope of scopes) {
      const text = (scope.innerText || '').toLowerCase();
      if (!text) continue;
      const hit = globalThis.CGA_ERROR_PATTERNS.find((p) => text.includes(p));
      if (hit && (!list.includes(scope) || text.length < 600)) return hit;
    }
    return null;
  }

  const refusalIn = (text) => {
    const t = flat(text);
    return t ? globalThis.CGA_REFUSAL_PATTERNS.find((p) => t.includes(p)) || null : null;
  };
  const asksQuestion = (text) => /[?？]\s*$/.test(String(text || '').trim());

  // ---- Typing and sending ----------------------------------------------------------------------

  async function setPrompt(text) {
    const el = await waitFor(composer, { timeout: 20000, label: 'the prompt box', stage: 'send' });
    el.focus();
    if (el.tagName === 'TEXTAREA') {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await sleep(150);
    if (normalize(composerText(el)) !== normalize(text)) {
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
    }
    await sleep(150);
    if (!normalize(composerText(el))) throw fail('Could not type the prompt', 'send');
  }

  async function attachFiles(files) {
    if (!files?.length) return;
    const list = await Promise.all(files.map(async ({ name, dataUrl }) => {
      const blob = await (await fetch(dataUrl)).blob();
      return new File([blob], name || 'image.png', { type: blob.type || 'image/png' });
    }));
    const dt = new DataTransfer();
    list.forEach((f) => dt.items.add(f));
    const input = q(S().fileInput);
    if (input) {
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const target = composer() || document.body;
      for (const type of ['dragenter', 'dragover', 'drop']) {
        target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
      }
    }
    await sleep(1000);
    await waitFor(() => {
      const area = composerArea();
      return !area || !qa(S().uploadInProgress, area).some(visible);
    }, { timeout: 120000, label: 'the image upload', stage: 'send' });
  }

  /**
   * The previous reply must be finished before typing: no prompt stream still open. Without the
   * page hook, the Stop button is the only sign; if it never goes away, go ahead anyway.
   */
  async function waitForIdle() {
    await waitFor(() => !liveStreams().some((s) => s.userText), { timeout: 120000, interval: 300, label: 'the previous reply to finish', stage: 'send' });
    if (!hookReady) await waitFor(() => !findStop(), { timeout: 60000, interval: 300 }).catch(() => {});
  }

  /** Click Send (or press Enter) and confirm the prompt went out. Never clicks Stop. */
  async function submit(typedAt, turnsBefore, sendWaitMs) {
    const box = composer();
    const sent = () => streams.some((s) => s.startedAt >= typedAt && s.userText)
      || !!findStop() || turns().length > turnsBefore || !normalize(composerText(composer() || box));
    const confirm = () => waitFor(sent, { timeout: 6000, interval: 150 }).then(() => true, () => false);

    const btn = await waitFor(() => {
      const b = findSend();
      return enabled(b) ? b : null;
    }, { timeout: sendWaitMs }).catch(() => null);
    if (btn) {
      btn.click();
      if (await confirm()) return;
    }
    if (sent()) return;
    const el = composer();
    if (!el) throw fail('Prompt box not found', 'send');
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    if (await confirm()) return;
    const late = findSend();
    if (enabled(late)) {
      late.click();
      if (await confirm()) return;
    }
    throw fail('Could not send the prompt: no Send button was found', 'send');
  }

  async function newChat() {
    const blank = () => !/\/c\/[\w-]+/.test(location.pathname) && turns().length === 0 && !!composer();
    if (blank()) return true;
    const btn = q(S().newChatButton);
    if (!btn) return false;
    btn.click();
    try {
      await waitFor(blank, { timeout: 8000, interval: 150, label: 'a new chat' });
      return true;
    } catch {
      return false;
    }
  }

  const convIdFromUrl = () => (/\/c\/([\w-]+)/.exec(location.pathname) || [])[1] || '';

  /** The image as a data: URL, or its http(s) address for the browser's download manager. */
  async function imageToDataUrl(img) {
    const src = srcOf(img);
    if (src.startsWith('data:')) return src;
    let same = src.startsWith('blob:');
    try { same = same || new URL(src, location.href).origin === location.origin; } catch { /* keep */ }
    for (const credentials of same ? ['include'] : ['omit', 'include']) {
      try {
        const res = await fetch(src, { credentials });
        if (res.ok) {
          const blob = await res.blob();
          if (blob.size) {
            return await new Promise((resolve, reject) => {
              const r = new FileReader();
              r.onload = () => resolve(r.result);
              r.onerror = reject;
              r.readAsDataURL(blob);
            });
          }
        }
      } catch { /* next */ }
    }
    try {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      return c.toDataURL('image/png');
    } catch { /* tainted */ }
    return new URL(src, location.href).href;
  }

  // ---- Jobs ----------------------------------------------------------------------------------

  const jobs = new Map();

  function note(job, text) {
    job.notes.push(text);
    if (job.notes.length > 20) job.notes.shift();
  }

  function finish(job, phase, fields = {}) {
    Object.assign(job, { phase, ...fields });
  }

  const failJob = (job, stage, error) => finish(job, 'error', { stage, error });

  /** The reply stream of the message we just sent (the first one carrying its text). */
  function bindStream(job) {
    if (job.stream || !job.typedAt) return;
    const want = flat(job.pendingText).slice(0, 80);
    // Sent after we finished typing (a click can't come earlier) and not another job's.
    const ours = streams.filter((s) => s.startedAt >= job.typedAt && s.userText && !s.claimed);
    // The one carrying our text; failing that (ChatGPT reworded it), the first prompt sent since we typed.
    job.stream = ours.find((s) => flat(s.userText).includes(want)) || ours[0] || null;
    if (job.stream) {
      job.stream.claimed = true;
      job.netSeen = true;
      if (!job.userId && job.pendingText === job.prompt) job.userId = job.stream.userId;
      if (job.stream.convId) job.convId = job.stream.convId;
    }
  }

  /** Is anything still streaming for this job's reply? Its own stream, or a resumed one for its chat. */
  function streaming(job) {
    if (job.stream && !job.stream.endedAt) return true;
    return !!job.convId && liveStreams().some((s) => s.startedAt >= (job.typedAt || 0) && s.convId === job.convId);
  }

  async function sendText(job, text, files = []) {
    job.phase = 'sending';
    await waitForIdle();
    await attachFiles(files);
    await setPrompt(text);
    job.typedAt = Date.now();
    job.pendingText = text;
    job.stream = null;
    await submit(job.typedAt, turns().length, files.length ? 120000 : 30000);
    job.sentAt = Date.now();
    job.lastChange = Date.now();
    job.lastSig = '';
    job.status = 'sent';
    bindStream(job);
    job.phase = 'waiting';
  }

  /**
   * After an interruption: is our prompt already the latest message in this chat? Then follow its
   * reply instead of sending it again.
   */
  async function tryResume(job) {
    const convId = convIdFromUrl();
    if (convId) {
      const res = await call('conversation', { id: convId }, 15000);
      if (res.ok) {
        const msgs = CONV().branch(res.data);
        const at = CONV().findAnchor(msgs, { prompt: job.prompt });
        if (at === -1) return false;
        const laterUsers = msgs.slice(at + 1).filter((m) => m.author?.role === 'user');
        const nudgeOnly = laterUsers.length === 1 && job.nudgeText
          && flat((laterUsers[0].content?.parts || []).filter((p) => typeof p === 'string').join(' ')) === flat(job.nudgeText);
        if (laterUsers.length && !nudgeOnly) return false;
        Object.assign(job, { convId, userId: msgs[at].id || '', nudged: nudgeOnly, resumed: true });
        return true;
      }
    }
    // Conversation not readable: go by the page.
    const list = turns();
    const users = list.filter((t) => !isReplyLike(t));
    const last = users[users.length - 1];
    if (!last) return false;
    const nudgeLast = job.nudgeText && showsPrompt(last, job.nudgeText);
    const own = showsPrompt(last, job.prompt) || (nudgeLast && users.length > 1 && showsPrompt(users[users.length - 2], job.prompt));
    if (!own) return false;
    Object.assign(job, { mode: 'page', nudged: !!nudgeLast, resumed: true, convId });
    return true;
  }

  async function startJob(job) {
    try {
      if (job.resume && await tryResume(job)) {
        note(job, 'already sent before the interruption: following its reply');
        job.typedAt = Date.now() - 1000;
        job.sentAt = Date.now();
        job.lastChange = Date.now();
        job.phase = 'waiting';
        job.status = 'replying';
      } else {
        await sendText(job, job.prompt, job.files);
      }
      job.files = null;
    } catch (e) {
      failJob(job, e.stage || 'send', String(e?.message || e));
    }
  }

  function startNudge(job) {
    job.nudged = true;
    job.status = 'nudged';
    sendText(job, job.nudgeText).catch((e) => failJob(job, e.stage || 'send', String(e?.message || e)));
  }

  /** One step forward. Called on every poll from the panel. */
  async function step(job) {
    const now = Date.now();
    if (now > job.deadline) {
      const busy = streaming(job) || job.analysis?.imagePending;
      return failJob(job, 'reply', busy ? 'Still generating when the time limit was reached' : 'Timed out waiting for the reply');
    }
    bindStream(job);
    const s = job.stream;
    if (s?.convId) job.convId = s.convId;
    if (!job.convId) job.convId = convIdFromUrl();
    if (s?.endedAt && !s.aborted && (s.error || s.status >= 400)) {
      return failJob(job, 'chatgpt', `ChatGPT error: ${s.error || `HTTP ${s.status}`}`);
    }
    if (streaming(job)) {
      job.status = s?.imageTask ? 'image' : s?.replying ? 'replying' : 'sent';
      job.lastChange = now;
      // A stream left open after the reply is complete must not hold the queue up: peek at the
      // conversation now and then, and go on once it has shown a finished reply for a while.
      if (job.mode === 'net' && job.convId && now - job.lastJsonAt >= STREAM_PEEK_MS) {
        const a = await readConversation(job, now);
        const complete = a?.anchor && a.final && (!job.expectImages || a.images.length);
        if (!complete) job.finalSince = 0;
        else if (!job.finalSince) job.finalSince = now;
        else if (now - job.finalSince >= OPEN_STREAM_DONE_MS) {
          note(job, 'the reply is finished but its stream stayed open');
          return collect(job, a);
        }
      }
      return;
    }
    if (job.mode === 'net') {
      if (!job.convId) {
        if (now - job.sentAt > NET_WAIT_MS) toPage(job, 'no conversation id');
        return;
      }
      return netStep(job, now);
    }
    return pageStep(job, now);
  }

  function toPage(job, why) {
    job.mode = 'page';
    job.lastChange = Date.now();
    job.lastSig = '';
    note(job, `watching the page instead (${why})`);
  }

  /** Read the conversation and analyze our prompt's reply (null when it can't be read). */
  async function readConversation(job, now) {
    job.lastJsonAt = now;
    const res = await call('conversation', { id: job.convId }, 15000);
    if (!res.ok) {
      job.jsonFails++;
      if (job.jsonFails >= 3) toPage(job, `conversation not readable: ${res.status || res.error}`);
      return null;
    }
    job.jsonFails = 0;
    const a = CONV().analyze(res.data, { userId: job.userId, prompt: job.prompt, since: job.resumed ? 0 : job.sentAt / 1000 });
    job.analysis = a;
    if (a.anchor && !job.userId) job.userId = a.anchorId;
    return a;
  }

  async function netStep(job, now) {
    if (now - job.lastJsonAt < JSON_EVERY_MS) return;
    const a = await readConversation(job, now);
    if (!a) return;
    if (!a.anchor) {
      if (now - job.sentAt > NO_PROMPT_MS) failJob(job, 'chatgpt', 'The prompt never reached the conversation');
      return;
    }
    if (a.signature !== job.lastSig) {
      job.lastSig = a.signature;
      job.lastChange = now;
    }
    const quiet = now - job.lastChange;
    if (a.imagePending) job.status = 'image';
    const settled = a.final || (quiet >= SETTLE_MS && !a.imagePending && (a.text || a.images.length));
    if (!settled) {
      if (quiet >= STALL_MS && !a.imagePending) failJob(job, 'reply', `ChatGPT stopped responding (nothing new for ${STALL_MS / 60000} min)`);
      return;
    }
    if (job.expectImages && !a.images.length) {
      if (refusalIn(a.text)) return finish(job, 'refused', { error: `Refused by ChatGPT: "${refusalIn(a.text)}"`, text: a.text });
      // A question back ("landscape or portrait?") is clearly the end; plain text gets a grace period.
      if (a.imagePending || quiet < (asksQuestion(a.lastText) ? 3000 : IMAGE_GRACE_MS)) return;
      if (!job.nudged && job.nudgeText) return startNudge(job);
      return failJob(job, 'chatgpt', 'No image was generated');
    }
    return collect(job, a);
  }

  /** Download the reply's images and finish the job. */
  async function collect(job, a) {
    job.phase = 'collecting';
    const images = [];
    for (const pointer of a.images) {
      const r = await call('image', { pointer, convId: job.convId }, 90000);
      if (r.ok && (r.dataUrl || r.url)) images.push(r.dataUrl || r.url);
    }
    if (a.images.length && images.length < a.images.length) {
      // The download link didn't work: take the pictures from the page instead.
      const shown = domImages(job);
      note(job, `image links failed for ${a.images.length - images.length}, using the page's images (${shown.length})`);
      if (shown.length > images.length) {
        images.length = 0;
        for (const img of shown) images.push(await imageToDataUrl(img));
      }
    }
    if (job.expectImages && !images.length) return failJob(job, 'reply', 'The image could not be downloaded');
    finish(job, 'done', { text: a.text, images, status: 'done' });
  }

  /** Fallback: decide from what the page shows. */
  async function pageStep(job, now) {
    const reply = replyTurns(job.prompt);
    const text = textOf(reply);
    const stop = !!findStop();
    if (stop) job.stopSeen = true;
    const images = job.expectImages ? domImages(job) : [];
    const bar = hasActionBar(reply);
    const sig = `${reply.length}|${text.length}|${images.map(srcOf).join(' ')}|${stop}|${bar}`;
    if (sig !== job.lastSig) {
      job.lastSig = sig;
      job.lastChange = now;
      return;
    }
    const quiet = now - job.lastChange;
    if (!stop) {
      const err = pageError(reply);
      if (err) return failJob(job, 'chatgpt', `ChatGPT error: ${err}`);
    }
    if (images.length && ((!stop && quiet >= 3000) || quiet >= SETTLE_MS)) {
      job.phase = 'collecting';
      const saved = [];
      for (const img of images) saved.push(await imageToDataUrl(img));
      return finish(job, 'done', { text, images: saved, status: 'done' });
    }
    if (!stop && text && quiet >= 2500) {
      const over = bar || job.stopSeen || job.netSeen || !!findSend() || quiet >= 20000;
      if (over && !job.expectImages) return finish(job, 'done', { text, images: [], status: 'done' });
      if (over && job.expectImages) {
        if (refusalIn(text)) return finish(job, 'refused', { error: `Refused by ChatGPT: "${refusalIn(text)}"`, text });
        if (!job.nudged && job.nudgeText && (asksQuestion(text) || quiet >= 30000)) return startNudge(job);
        if (job.nudged && quiet >= 60000) return failJob(job, 'chatgpt', 'No image was generated');
      }
    }
    if (!stop && quiet >= STALL_MS) failJob(job, 'reply', `ChatGPT stopped responding (nothing new for ${STALL_MS / 60000} min)`);
  }

  async function tick(job) {
    if (job.phase !== 'waiting' || job.ticking) return;
    job.ticking = true;
    try {
      await step(job);
    } catch (e) {
      note(job, `check failed: ${String(e?.message || e)}`);
    } finally {
      job.ticking = false;
    }
  }

  function snapshot(job) {
    const out = {
      ok: true,
      state: job.phase,
      status: job.status,
      mode: job.mode,
      url: location.href,
      resumed: !!job.resumed,
      nudged: !!job.nudged,
      notes: job.notes.slice(),
      visibility: document.visibilityState,
    };
    if (job.phase === 'done') Object.assign(out, { text: job.text, images: job.images });
    if (job.phase === 'refused') Object.assign(out, { error: job.error, text: job.text || '' });
    if (job.phase === 'error') Object.assign(out, { error: job.error, stage: job.stage });
    return out;
  }

  function createJob(p) {
    for (const old of jobs.values()) if (old.phase === 'waiting' || old.phase === 'sending') failJob(old, 'reply', 'Replaced by a newer prompt');
    if (jobs.size > 10) jobs.delete(jobs.keys().next().value);
    const job = {
      id: p.id,
      prompt: String(p.prompt || ''),
      files: p.files || [],
      expectImages: !!p.expectImages,
      nudgeText: p.expectImages ? (p.nudgeText ?? globalThis.CGA_IMAGE_NUDGE) : '',
      resume: !!p.resume,
      deadline: Date.now() + Math.max(60000, Number(p.timeoutMs) || 10 * 60000),
      phase: 'sending',
      status: 'typing',
      mode: hookReady ? 'net' : 'page',
      notes: [],
      jsonFails: 0,
      lastJsonAt: 0,
      lastChange: Date.now(),
      lastSig: '',
      sentAt: Date.now(),
      baseline: new Set(conversationImages().map(srcOf)),
      convId: '',
      userId: '',
    };
    if (!hookReady) note(job, 'page hook not loaded: watching the page');
    jobs.set(job.id, job);
    return job;
  }

  function diagnose() {
    const job = [...jobs.values()].pop();
    const box = composer();
    return {
      url: location.href,
      visibility: document.visibilityState,
      hook: hookReady,
      composer: !!box,
      send: !!findSend(),
      stop: !!findStop(),
      turns: turns().length,
      streams: streams.slice(-5).map((s) => ({
        path: s.path, open: !s.endedAt, secs: Math.round(((s.endedAt || Date.now()) - s.startedAt) / 1000), status: s.status,
        convId: s.convId ? `${s.convId.slice(0, 8)}…` : '', imageTask: s.imageTask, error: s.error, types: (s.types || []).slice(0, 15),
      })),
      job: job && {
        phase: job.phase, status: job.status, mode: job.mode, stream: !!job.stream, convId: !!job.convId,
        analysis: job.analysis && {
          anchor: job.analysis.anchor, final: job.analysis.final, lastRole: job.analysis.lastRole, lastStatus: job.analysis.lastStatus,
          images: job.analysis.images?.length, imagePending: job.analysis.imagePending, chars: job.analysis.text?.length,
        },
        notes: job.notes.slice(-5),
      },
      userAgent: navigator.userAgent,
    };
  }

  globalThis.__CGA_AGENT = { createJob, startJob, tick, snapshot, diagnose, jobs, streams, findSend, findStop };

  if (!ext?.runtime?.onMessage) return;
  ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('CGA_')) return false;
    switch (msg.type) {
      case 'CGA_PING':
        sendResponse({ ok: true, ready: !!composer(), hook: hookReady, url: location.href, visibility: document.visibilityState, loadedAt: performance.timeOrigin });
        return false;
      case 'CGA_SUBMIT': {
        const job = createJob(msg.job || {});
        startJob(job);
        sendResponse({ ok: true });
        return false;
      }
      case 'CGA_POLL': {
        const job = jobs.get(msg.id);
        if (!job) {
          sendResponse({ ok: true, state: 'lost', url: location.href });
          return false;
        }
        tick(job).then(() => sendResponse(snapshot(job)));
        return true;
      }
      case 'CGA_NEW_CHAT':
        newChat().then((ok) => sendResponse({ ok, url: location.href }));
        return true;
      case 'CGA_STOP':
      case 'CGA_FIX': {
        // Stop leaves ChatGPT's reply running (Run picks it up); Fix Error also stops ChatGPT and
        // closes whatever dialog is open.
        for (const job of jobs.values()) if (job.phase === 'waiting' || job.phase === 'sending') failJob(job, 'reply', 'Stopped');
        const stop = msg.type === 'CGA_FIX' ? findStop() : null;
        if (stop) stop.click();
        if (msg.type === 'CGA_FIX') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
        sendResponse({ ok: true, stopped: !!stop });
        return false;
      }
      case 'CGA_DIAGNOSE': {
        let d;
        try { d = diagnose(); } catch (e) { d = { error: String(e?.message || e) }; }
        sendResponse({ ok: true, diagnostics: d });
        return false;
      }
      default:
        return false;
    }
  });
})();
