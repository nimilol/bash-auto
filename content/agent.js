// Content script for chatgpt.com: sends one prompt at a time and follows it until its reply
// (text or images) is complete. The service worker starts a job with CGA_SUBMIT and then polls it
// with CGA_POLL every ~1.5 s. Each poll moves the job forward, so background-tab timer throttling
// never slows it down.
//
// Each poll gathers three independent signals and hands them to CGA_DECIDE.decide():
//   stream  the reply stream for our prompt (page-hook.js): open, closed, failed, connection lost
//   json    ChatGPT's own conversation data: our message, new images, messages still in progress
//   dom     the page: reply text, finished images, progress indicators, Stop button, errors
// Classic script, guarded so a second injection is harmless.
(() => {
  // A copy left over from before the extension was reloaded can't talk to it any more: replace it.
  if (globalThis.__CGA_AGENT && globalThis.__CGA_AGENT.alive()) return;

  const D = () => globalThis.CGA_DOM;
  const CONV = () => globalThis.CGA_CONV;
  const DECIDE = () => globalThis.CGA_DECIDE;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/[‘’ʼ]/g, "'");
  const convIdFromUrl = () => (/\/c\/([0-9a-f][\w-]{7,})/i.exec(location.pathname) || [])[1] || '';

  const JSON_EVERY_MS = 2500;
  const IMAGE_NUDGE = 'Yes, please generate the image now, exactly as described.';

  function fail(message, stage = 'send') {
    const e = new Error(message);
    e.stage = stage;
    return e;
  }

  // ---- Bridge to page-hook.js ------------------------------------------------------------------
  const streams = [];
  let hookReady = false;
  let callId = 0;
  const calls = new Map();
  const pushed = new Map(); // conversation id -> last push time

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (e.source !== window || !m || m.cga !== 'hook') return;
    hookReady = true;
    if (m.t === 'start') {
      streams.push({
        sid: m.sid, userId: m.userId || '', userText: m.userText || '', convId: m.convId || '', startedAt: Date.now(), endedAt: 0,
        imageTask: false, error: '', status: 0, aborted: false, network: false, tooLong: false, replying: false, claimed: false,
      });
      if (streams.length > 50) streams.shift();
    } else if (m.t === 'update' || m.t === 'end') {
      const s = streams.find((x) => x.sid === m.sid);
      if (!s) return;
      if (m.convId) s.convId = m.convId;
      s.imageTask = s.imageTask || !!m.imageTask;
      if (m.error) s.error = m.error;
      if (m.replying) s.replying = true;
      if (m.tooLong) s.tooLong = true;
      if (m.t === 'end') {
        Object.assign(s, { endedAt: Date.now(), status: m.status, aborted: !!m.aborted, types: m.types || [] });
        if (m.aborted) {
          // 'aborted' is the page's own Stop or a navigation; anything else is the connection.
          const why = m.abortError || m.error || '';
          s.network = !!m.network || !!m.offline || (!!why && why !== 'aborted');
          if (!s.error && s.network) s.error = why;
        }
      }
    } else if (m.t === 'push') {
      for (const id of m.ids || []) pushed.set(id, Date.now());
    } else if (m.t === 'reply') {
      const done = calls.get(m.id);
      calls.delete(m.id);
      done?.(m);
    }
  });

  /** Ask page-hook.js to do something with the page's login. Never rejects. */
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

  let online = navigator.onLine !== false;
  window.addEventListener('online', () => { online = true; });
  window.addEventListener('offline', () => { online = false; });

  const liveStreams = () => streams.filter((s) => !s.endedAt);

  async function waitFor(fn, { timeout = 30000, interval = 250, what = 'the page', stage = 'send' } = {}) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(interval);
    }
    throw fail(`Timed out waiting for ${what}`, stage);
  }

  // ---- Typing and sending ----------------------------------------------------------------------
  async function setPrompt(text) {
    const el = await waitFor(D().composer, { timeout: 30000, what: 'the prompt box' });
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
    if (D().normalize(D().composerText(el)) !== D().normalize(text)) {
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
    }
    await sleep(150);
    if (!D().normalize(D().composerText(el))) throw fail('Could not type the prompt');
  }

  async function attachFiles(files) {
    if (!files?.length) return;
    const list = await Promise.all(files.map(async ({ name, dataUrl }) => {
      const blob = await (await fetch(dataUrl)).blob();
      return new File([blob], name || 'image.png', { type: blob.type || 'image/png' });
    }));
    const dt = new DataTransfer();
    list.forEach((f) => dt.items.add(f));
    const input = D().q(D().SEL.fileInput);
    if (input) {
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const target = D().composer() || document.body;
      for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    }
    await sleep(1000);
    await waitFor(() => {
      const area = D().composerArea();
      return !area || !D().qa(D().SEL.uploadInProgress, area).some(D().visible);
    }, { timeout: 180000, what: 'the image upload' });
  }

  /** The previous reply must be finished before typing. */
  async function waitForIdle() {
    await waitFor(() => !liveStreams().some((s) => s.userText), { timeout: 180000, interval: 300, what: 'the previous reply to finish' });
    if (!hookReady) await waitFor(() => !D().findStop(), { timeout: 60000, interval: 300 }).catch(() => {});
  }

  /** Click Send (or press Enter) and confirm the prompt went out. Never clicks Stop. */
  async function submit(typedAt, turnsBefore, sendWaitMs) {
    const sent = () => streams.some((s) => s.startedAt >= typedAt && s.userText)
      || !!D().findStop() || D().turns().length > turnsBefore || !D().normalize(D().composerText(D().composer()));
    const confirm = () => waitFor(sent, { timeout: 6000, interval: 150 }).then(() => true, () => false);
    const btn = await waitFor(() => {
      const b = D().findSend();
      return D().enabled(b) ? b : null;
    }, { timeout: sendWaitMs }).catch(() => null);
    if (btn) {
      btn.click();
      if (await confirm()) return;
    }
    if (sent()) return;
    const el = D().composer();
    if (!el) throw fail('Prompt box not found');
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    if (await confirm()) return;
    const late = D().findSend();
    if (D().enabled(late)) {
      late.click();
      if (await confirm()) return;
    }
    throw fail('Could not send the prompt: no Send button responded');
  }

  async function newChat() {
    const blank = () => !convIdFromUrl() && D().turns().length === 0 && !!D().composer();
    if (blank()) return true;
    const btn = D().q(D().SEL.newChat);
    if (!btn) return false;
    btn.click();
    try {
      await waitFor(blank, { timeout: 8000, interval: 150 });
      return true;
    } catch {
      return false;
    }
  }

  // ---- Images --------------------------------------------------------------------------------
  const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });

  /** A page image as a data: URL (or its http address for the browser's downloader). */
  async function pageImageData(img) {
    const src = D().srcOf(img);
    if (src.startsWith('data:')) return src;
    let same = src.startsWith('blob:');
    try { same = same || new URL(src, location.href).origin === location.origin; } catch { /* keep */ }
    for (const credentials of same ? ['include'] : ['omit', 'include']) {
      try {
        const res = await fetch(src, { credentials });
        if (res.ok) {
          const blob = await res.blob();
          if (blob.size) return await blobToDataUrl(blob);
        }
      } catch { /* next */ }
    }
    try {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      return c.toDataURL('image/png');
    } catch { /* tainted canvas */ }
    return new URL(src, location.href).href;
  }

  /** A small JPEG preview for the panel's queue list. */
  async function thumbnail(dataUrl) {
    if (!/^data:image\//.test(dataUrl || '')) return '';
    try {
      const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
      const scale = 160 / Math.max(bmp.width, bmp.height);
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(bmp.width * scale));
      c.height = Math.max(1, Math.round(bmp.height * scale));
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.75);
    } catch {
      return '';
    }
  }

  // ---- Jobs ----------------------------------------------------------------------------------
  const jobs = new Map();

  function note(job, text) {
    job.notes.push(text);
    if (job.notes.length > 40) job.notes.shift();
  }

  function end(job, phase, fields = {}) {
    Object.assign(job, { phase, ...fields });
  }

  /** The reply stream of the text we just sent (the first one carrying it). */
  function bindStream(job) {
    if (job.stream || !job.typedAt) return;
    const want = flat(job.pendingText).slice(0, 80);
    const ours = streams.filter((s) => s.startedAt >= job.typedAt && s.userText && !s.claimed);
    job.stream = ours.find((s) => flat(s.userText).includes(want)) || ours[0] || null;
    if (!job.stream) return;
    job.stream.claimed = true;
    if (!job.userId && job.pendingText === job.prompt && job.stream.userId) job.userId = job.stream.userId;
    if (job.stream.convId) job.convId = job.stream.convId;
  }

  function streamSignal(job) {
    const s = job.stream;
    const live = job.convId && liveStreams().some((x) => x !== s && x.startedAt >= (job.typedAt || job.startedAt) && x.convId === job.convId);
    if (!s) return { open: !!live, ended: false };
    return {
      open: !s.endedAt || !!live,
      ended: !!s.endedAt && !live,
      error: s.error,
      status: s.status,
      aborted: s.aborted,
      network: s.network,
      tooLong: s.tooLong,
    };
  }

  async function readConversation(job) {
    job.lastJsonAt = Date.now();
    const id = job.convId || convIdFromUrl();
    if (!id) return null;
    job.convId = id;
    const res = await call('conversation', { id }, 15000);
    if (!res.ok) {
      if (res.network || !online) job.jsonNetFails++;
      else job.jsonFails++;
      if (job.jsonFails === 3) note(job, `conversation not readable (${res.status || res.error}): watching the page`);
      return job.jsonFails >= 3 ? null : job.json;
    }
    job.jsonFails = 0;
    job.jsonNetFails = 0;
    const a = CONV().analyze(res.data, {
      userId: job.userId, prompt: job.prompt, afterId: job.afterId, baseline: job.baseline,
      since: job.resumed ? 0 : job.sentAt / 1000, followUps: [job.nudgeText].filter(Boolean),
    });
    if (a.anchor && !job.userId) job.userId = a.anchorId;
    job.json = a;
    return a;
  }

  // Only one prompt is typed and sent at a time, and a new job waits for one still being sent
  // (after Recover, say) before it looks in the chat, so it sees that prompt and doesn't send it again.
  let sending = Promise.resolve();

  function sendText(job, text, files = []) {
    const run = sending.catch(() => {}).then(() => doSend(job, text, files));
    sending = run;
    return run;
  }

  async function doSend(job, text, files) {
    if (job.phase === 'error') throw fail('Stopped');
    job.phase = 'sending';
    job.status = 'typing';
    await waitForIdle();
    await attachFiles(files);
    await setPrompt(text);
    job.typedAt = Date.now();
    job.pendingText = text;
    job.stream = null;
    await submit(job.typedAt, D().turns().length, files.length ? 180000 : 30000);
    job.sentAt = job.sentAt || Date.now();
    job.lastChange = Date.now();
    job.imagesChangedAt = Date.now();
    job.sig = '';
    job.status = 'sent';
    bindStream(job);
    job.phase = 'waiting';
  }

  /**
   * Before sending: is this prompt already in the chat (sent before an interruption)? Then follow
   * its reply. Returns 'follow' | 'send'.
   */
  async function findExisting(job) {
    const id = convIdFromUrl();
    if (!id) return 'send';
    job.convId = id;
    const res = await call('conversation', { id }, 15000);
    if (res.ok) {
      const opts = { userId: job.userId, prompt: job.prompt, afterId: job.afterId, followUps: [job.nudgeText].filter(Boolean) };
      const a = CONV().analyze(res.data, opts);
      if (!a.anchor) return 'send';
      // If it has to be sent again, the new copy comes after this one.
      job.afterId = a.anchorId;
      if (a.laterPrompt) return 'send';
      // After "no image" or a ChatGPT error, only a late image, or work that is still going on
      // without an error showing in the reply, is followed. Anything else is sent again.
      if (job.resumeStrict && !a.images.length) {
        const shownError = D().readReply(job.prompt, { followUps: opts.followUps }).replyError;
        if (!(a.inProgress || a.imagePending) || shownError) return 'send';
      }
      // The reply died with an error and nothing is coming: send the prompt again.
      if (a.error && !a.images.length && !a.inProgress && !a.text) return 'send';
      if (!a.text && !a.images.length && !a.inProgress && !a.turnOpen && !a.imageTask) return 'send';
      // This prompt's own images are not part of the "already in the chat" baseline.
      job.baseline = CONV().allPointers(res.data).filter((p) => !a.images.includes(p));
      job.userId = a.anchorId;
      job.json = CONV().analyze(res.data, { ...opts, userId: a.anchorId, baseline: job.baseline });
      return 'follow';
    }
    if (res.network) throw Object.assign(fail('ChatGPT could not be reached', 'network'), { network: true });
    // Conversation not readable: go by the page, only if the latest prompt on it is ours.
    const users = D().turns().filter((t) => D().roleOf(t) === 'user');
    const last = users[users.length - 1];
    const followUp = job.nudgeText && last && D().showsText(last, job.nudgeText);
    const own = last && (D().showsText(last, job.prompt) || (followUp && users.length > 1 && D().showsText(users[users.length - 2], job.prompt)));
    return own ? 'follow' : 'send';
  }

  async function startJob(job) {
    try {
      await sending.catch(() => {});
      await waitFor(() => D().composer() || D().loginNeeded(), { timeout: 30000, what: 'the prompt box' });
      if (D().loginNeeded()) return end(job, 'error', { kind: 'login', error: 'Log in to ChatGPT in this tab' });
      // Images already in this chat are not ours (a long single-chat run has many).
      const id = convIdFromUrl();
      if (id) {
        const res = await call('conversation', { id }, 15000);
        if (res.ok) job.baseline = CONV().allPointers(res.data);
        else if (res.network) throw Object.assign(fail('ChatGPT could not be reached', 'network'), { network: true });
      }
      job.domBaseline = new Set(D().allImageSrcs());
      if (job.resume && (await findExisting(job)) === 'follow') {
        // Its own images on the page belong to this prompt, not to the baseline.
        const { turns: list } = D().replyTurns(job.prompt, [job.nudgeText].filter(Boolean));
        list.forEach((t) => t.querySelectorAll('img').forEach((img) => job.domBaseline.delete(D().srcOf(img))));
        note(job, 'already in the chat: following its reply instead of sending it again');
        Object.assign(job, { resumed: true, typedAt: Date.now() - 1000, sentAt: Date.now(), lastChange: Date.now(), imagesChangedAt: Date.now(), phase: 'waiting', status: 'replying' });
        // A half-done question/nudge is handled by the decision as usual.
      } else {
        // A fresh send: follow the new message, not an earlier copy of the prompt.
        Object.assign(job, { userId: '', json: null, resumed: false });
        await sendText(job, job.prompt, job.files);
      }
      job.files = null;
    } catch (e) {
      if (e.network || !online) end(job, 'network', { error: String(e?.message || e) });
      else end(job, 'error', { kind: e.stage === 'network' ? 'network' : 'send', error: String(e?.message || e) });
    }
  }

  function startNudge(job) {
    job.nudged = true;
    job.finalCheckDone = false;
    job.status = 'nudged';
    note(job, 'ChatGPT replied without an image: asking it once to generate the image');
    sendText(job, job.nudgeText).catch((e) => end(job, 'error', { kind: 'send', error: String(e?.message || e) }));
  }

  async function collect(job, source) {
    job.phase = 'collecting';
    job.status = 'saving';
    const out = [];
    const pointers = job.json?.anchor ? job.json.images : [];
    let networkFail = false;
    for (const pointer of pointers) {
      let r = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        r = await call('image', { pointer, convId: job.convId }, 90000);
        if (r.ok && r.dataUrl) break;
        if (r.network) networkFail = true;
        await sleep(1500 * (attempt + 1));
      }
      if (r?.ok && (r.dataUrl || r.url)) out.push({ data: r.dataUrl || '', url: r.url || '' });
    }
    if (job.expectImages && (out.length < pointers.length || !pointers.length)) {
      const shown = job.dom?.imageEls || D().readReply(job.prompt, { baseline: job.domBaseline, followUps: [job.nudgeText].filter(Boolean) }).imageEls;
      if (shown.length > out.length) {
        if (pointers.length) note(job, `image links failed for ${pointers.length - out.length}: saving the page's images (${shown.length})`);
        out.length = 0;
        for (const img of shown) {
          const got = await pageImageData(img);
          out.push(got.startsWith('data:') ? { data: got, url: '' } : { data: '', url: got });
        }
      }
    }
    if (job.expectImages && !out.length) {
      if (networkFail || !online) return end(job, 'network', { error: 'The image could not be downloaded: connection lost' });
      return end(job, 'error', { kind: 'stale', error: 'The image is in the chat but could not be downloaded yet' });
    }
    const thumbs = [];
    for (const img of out.slice(0, 4)) thumbs.push(await thumbnail(img.data));
    const text = (job.json?.anchor ? job.json.text : '') || job.dom?.text || '';
    end(job, 'done', { text, images: out, thumbs, source, status: 'done' });
  }

  /** One step forward; called on every poll. */
  async function step(job) {
    const now = Date.now();
    bindStream(job);
    if (job.stream?.convId) job.convId = job.stream.convId;
    if (!job.convId) job.convId = convIdFromUrl();
    if (job.stream?.userId && !job.userId && job.pendingText === job.prompt) job.userId = job.stream.userId;

    const forced = job.convId && (pushed.get(job.convId) || 0) > job.lastJsonAt;
    if (job.convId && (forced || now - job.lastJsonAt >= (job.jsonFails >= 3 ? 15000 : JSON_EVERY_MS))) await readConversation(job);
    const followUps = [job.nudgeText].filter(Boolean);
    job.dom = D().readReply(job.prompt, { baseline: job.domBaseline, followUps });

    const json = job.jsonFails >= 3 ? null : job.json;
    const st = streamSignal(job);
    const imgKey = `${(json?.anchor ? json.images : []).join(',')}|${job.dom.images}`;
    if (imgKey !== job.imgKey) {
      job.imgKey = imgKey;
      job.imagesChangedAt = now;
    }
    const sig = `${json?.signature || '-'}|${job.dom.signature}|${st.open}|${st.ended}|${job.dom.stop}`;
    if (sig !== job.sig) {
      job.sig = sig;
      job.lastChange = now;
    }
    const decision = DECIDE().decide(job, {
      now, online, stream: st, json, jsonNetworkFails: job.jsonNetFails, dom: job.dom,
    });
    job.decision = decision.type === 'wait' ? `wait:${decision.status}` : decision.type;
    switch (decision.type) {
      case 'wait':
        job.status = job.nudged && decision.status !== 'image' ? 'nudged' : decision.status;
        return;
      case 'collect':
        return collect(job, decision.source);
      case 'nudge':
        return startNudge(job);
      case 'finalCheck':
        job.finalCheckDone = true;
        job.lastJsonAt = 0;
        note(job, 'no image yet and nothing generating: taking one last look');
        return;
      case 'refused':
        return end(job, 'refused', { error: decision.error, text: json?.text || job.dom.text || '' });
      case 'network':
        return end(job, 'network', { error: decision.error });
      default:
        return end(job, 'error', { kind: decision.kind, error: decision.error });
    }
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
      url: location.href,
      convId: job.convId || convIdFromUrl(),
      userId: job.userId || '',
      sent: !!job.typedAt,
      resumed: !!job.resumed,
      nudged: !!job.nudged,
      notes: job.notes.slice(),
      online,
      visibility: document.visibilityState,
    };
    if (job.phase === 'done') Object.assign(out, { text: job.text, images: job.images, thumbs: job.thumbs, source: job.source });
    if (job.phase === 'refused') Object.assign(out, { error: job.error, text: job.text || '' });
    if (job.phase === 'error' || job.phase === 'network') Object.assign(out, { error: job.error, kind: job.kind || job.phase });
    return out;
  }

  function createJob(p) {
    for (const old of jobs.values()) if (['sending', 'waiting', 'collecting'].includes(old.phase)) end(old, 'error', { kind: 'replaced', error: 'Replaced by a newer prompt' });
    while (jobs.size > 10) jobs.delete(jobs.keys().next().value);
    const t = p.timings || {};
    const job = {
      id: p.id,
      prompt: String(p.prompt || ''),
      files: p.files || [],
      expectImages: !!p.expectImages,
      nudgeText: p.expectImages ? String(p.nudgeText ?? IMAGE_NUDGE) : '',
      canNudge: !!p.expectImages && p.nudge !== false,
      resume: !!p.resume,
      resumeStrict: !!p.resumeStrict,
      userId: p.userId || '',
      afterId: p.afterId || '',
      quietMs: Math.max(3000, Number(t.quietMs) || 180000),
      capMs: Math.max(10000, Number(t.capMs) || 30 * 60000),
      staleMs: Math.max(10000, Number(t.staleMs) || 10 * 60000),
      phase: 'sending',
      status: 'typing',
      notes: [],
      startedAt: Date.now(),
      sentAt: 0,
      lastChange: Date.now(),
      imagesChangedAt: Date.now(),
      lastJsonAt: 0,
      jsonFails: 0,
      jsonNetFails: 0,
      baseline: [],
      domBaseline: new Set(),
      convId: '',
      json: null,
      dom: null,
      sig: '',
    };
    if (!hookReady) note(job, 'page hook not loaded yet: the page is watched until it is');
    jobs.set(job.id, job);
    return job;
  }

  function diagnose() {
    const job = [...jobs.values()].pop();
    return {
      url: location.href,
      visibility: document.visibilityState,
      online,
      hook: hookReady,
      composer: !!D().composer(),
      login: D().loginNeeded(),
      send: !!D().findSend(),
      stop: !!D().findStop(),
      turns: D().turns().length,
      streams: streams.slice(-5).map((s) => ({
        open: !s.endedAt, secs: Math.round(((s.endedAt || Date.now()) - s.startedAt) / 1000), status: s.status,
        conv: s.convId ? `${s.convId.slice(0, 8)}…` : '', imageTask: s.imageTask, error: s.error, aborted: s.aborted, network: s.network, types: (s.types || []).slice(0, 12),
      })),
      job: job && {
        phase: job.phase, status: job.status, decision: job.decision, stream: !!job.stream, conv: !!job.convId, userId: !!job.userId,
        json: job.json && {
          anchor: job.json.anchor, final: job.json.final, inProgress: job.json.inProgress, turnOpen: job.json.turnOpen, imageTask: job.json.imageTask,
          images: job.json.images?.length, partials: job.json.partials, lastRole: job.json.lastRole, lastStatus: job.json.lastStatus, chars: job.json.text?.length,
        },
        dom: job.dom && { shown: job.dom.promptShown, images: job.dom.images, generating: job.dom.generating, stop: job.dom.stop, error: job.dom.error, chars: job.dom.text?.length },
        quietSecs: Math.round((Date.now() - job.lastChange) / 1000),
        notes: job.notes.slice(-5),
      },
    };
  }

  const ext = globalThis.chrome;
  const alive = () => { try { return !!ext?.runtime?.id; } catch { return false; } };
  globalThis.__CGA_AGENT = { createJob, startJob, tick, snapshot, diagnose, jobs, streams, newChat, alive };

  if (!ext?.runtime?.onMessage) return;
  ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('CGA_')) return false;
    switch (msg.type) {
      case 'CGA_PING':
        sendResponse({
          ok: true, ready: !!D().composer(), login: D().loginNeeded(), hook: hookReady, url: location.href, convId: convIdFromUrl(),
          online, visibility: document.visibilityState, loadedAt: performance.timeOrigin,
        });
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
          sendResponse({ ok: true, state: 'lost', url: location.href, online });
          return false;
        }
        tick(job).then(() => sendResponse(snapshot(job)), () => sendResponse(snapshot(job)));
        return true;
      }
      case 'CGA_NEW_CHAT':
        newChat().then((ok) => sendResponse({ ok, url: location.href }));
        return true;
      case 'CGA_PROBE':
        call('probe', {}, 12000).then((r) => sendResponse({ ok: true, online: online && r.ok && r.online !== false, hook: hookReady }));
        return true;
      case 'CGA_ABORT': {
        for (const job of jobs.values()) if (['sending', 'waiting', 'collecting'].includes(job.phase)) end(job, 'error', { kind: 'stopped', error: 'Stopped' });
        const stop = msg.clickStop ? D().findStop() : null;
        if (stop) stop.click();
        if (msg.clickStop) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
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
