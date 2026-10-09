// Content script for chatgpt.com. Drives one prompt at a time on request from the side panel.
// Classic script (content scripts cannot be ES modules); guarded so re-injection is harmless.
(() => {
  if (globalThis.__CGA_DRIVER) return;

  // Firefox exposes `browser` (promise based); Chromium browsers expose `chrome`.
  const ext = globalThis.browser?.runtime?.onMessage ? globalThis.browser : globalThis.chrome;
  const S = () => globalThis.CGA_SELECTORS;
  const L = () => globalThis.CGA_LABELS;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Without a stop button to watch, a reply only counts as finished after this much quiet.
  const QUIET_FALLBACK_MS = 20000;
  // No sign of life for this long after sending means ChatGPT stopped responding.
  const STALL_MS = 3 * 60 * 1000;

  /** Error with the stage it happened in:
   * 'send'    — the prompt never went out; safe to send again.
   * 'reply'   — the prompt is in the chat but its reply wasn't collected (timeout, stall);
   *             the next attempt picks the reply up instead of sending twice.
   * 'chatgpt' — ChatGPT answered with an error or no image; the prompt is sent again. */
  function fail(message, stage) {
    const e = new Error(message);
    e.stage = stage;
    return e;
  }

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

  /** Drop elements nested inside another element of the list. */
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

  const normalize = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  // Curly apostrophes etc. so "can’t" matches "can't".
  const flat = (s) => normalize(s).toLowerCase().replace(/[‘’ʼ]/g, "'");

  // ---- Composer and its buttons -------------------------------------------------------------

  function composer() {
    for (const sel of S().composer) {
      const all = [...document.querySelectorAll(sel)];
      const el = all.find(visible) || all[0];
      if (el) return el;
    }
    return null;
  }

  function composerText(el) {
    return el.tagName === 'TEXTAREA' ? el.value : el.innerText;
  }

  /** The composer's form (or, failing that, a few levels up): where Send/Stop live. */
  function composerArea() {
    const el = composer();
    if (!el) return null;
    const form = el.closest('form');
    if (form) return form;
    let node = el;
    for (let i = 0; i < 5 && node.parentElement; i++) node = node.parentElement;
    return node;
  }

  function label(btn) {
    return flat(btn.getAttribute('aria-label') || btn.getAttribute('title') || btn.innerText || '');
  }

  function hasStopIcon(btn) {
    const svg = btn.querySelector('svg');
    if (!svg) return false;
    if (svg.querySelector('use[href*="stop" i]')) return true;
    const shapes = svg.querySelectorAll('path, rect, circle, line, polygon, polyline, ellipse');
    if (shapes.length !== 1) return false;
    const shape = shapes[0];
    if (shape.tagName.toLowerCase() === 'rect') return true;
    const d = (shape.getAttribute('d') || '').trim();
    return S().stopIconPaths.some((p) => d.startsWith(p));
  }

  /** 'stop' | 'send' | 'other'. Test id first, then label (any language), then icon, then type. */
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

  /** Visible buttons that may be Send or Stop: known selectors plus every button by the composer. */
  function controlCandidates() {
    const area = composerArea();
    const known = qa([...S().submitSlot, ...S().sendButton, ...S().stopButton]);
    const local = area ? [...area.querySelectorAll('button')] : [];
    return [...new Set([...known, ...local])].filter(visible);
  }

  function findStop() {
    return qa(S().stopButton).find(visible) || controlCandidates().find((b) => buttonKind(b) === 'stop') || null;
  }

  function findSend() {
    return controlCandidates().find((b) => buttonKind(b) === 'send') || null;
  }

  const enabled = (b) => !!b && !b.disabled && b.getAttribute('aria-disabled') !== 'true';

  function isGenerating() {
    return !!findStop() || !!q(S().streaming);
  }

  // ---- Conversation turns -------------------------------------------------------------------

  function turns() {
    for (const sel of S().turn) {
      const els = outermost([...document.querySelectorAll(sel)]);
      if (els.length) return els;
    }
    return outermost(qa([S().userMessage, S().assistantMessage]));
  }

  /** 'user' | 'assistant' | null when the page doesn't say. */
  function roleOf(turn) {
    const own = turn.getAttribute('data-turn') || turn.getAttribute('data-message-author-role');
    if (own === 'user' || own === 'assistant') return own;
    if (turn.querySelector(S().userMessage)) return 'user';
    if (turn.querySelector(S().assistantMessage)) return 'assistant';
    return null;
  }

  /** A reply rather than a prompt: by role when the page says, else by having a markdown body. */
  function isReplyLike(turn) {
    const role = roleOf(turn);
    if (role) return role === 'assistant';
    return !!q(S().markdown, turn);
  }

  /** Does this (non-reply) turn show the given prompt? Compares the first 80 characters, which
   * stay visible when ChatGPT collapses a long prompt and sit after any attachment names. */
  function showsPrompt(turn, prompt) {
    if (isReplyLike(turn)) return false;
    const head = flat(prompt).slice(0, 80);
    return !!head && flat(turn.innerText).includes(head);
  }

  /**
   * Index of the turn holding our prompt: the first one at or after `from` that shows it (our
   * prompt comes before its reply). Falls back to the latest one anywhere, for when ChatGPT
   * re-renders the thread and positions shift. Replies are the turns after it, so no role
   * markers are needed.
   */
  function findAnchor(prompt, from = 0) {
    const list = turns();
    for (let i = Math.max(0, from); i < list.length; i++) if (showsPrompt(list[i], prompt)) return i;
    for (let i = list.length - 1; i >= 0; i--) if (showsPrompt(list[i], prompt)) return i;
    return -1;
  }

  function replyTurns(prompt, from) {
    const list = turns();
    const anchor = findAnchor(prompt, from);
    if (anchor === -1) return [];
    return list.slice(anchor + 1).filter((t) => roleOf(t) !== 'user');
  }

  function textOf(turnsList) {
    return turnsList
      .map((t) => {
        const mds = outermost(qa(S().markdown, t));
        if (mds.length) return mds.map((m) => m.innerText.trim()).filter(Boolean).join('\n\n');
        // No markdown container: the turn's own text minus its buttons.
        const clone = t.cloneNode(true);
        clone.querySelectorAll('button, [role="button"], svg').forEach((b) => b.remove());
        return clone.innerText.trim();
      })
      .filter(Boolean)
      .join('\n\n');
  }

  function hasActionBar(turnsList) {
    return turnsList.some((t) => {
      if (q(S().actionBar, t)) return true;
      return [...t.querySelectorAll('button')].some((b) => {
        const text = label(b);
        return text && L().copy.some((w) => text.includes(w));
      });
    });
  }

  function imagesIn(turnsList) {
    const seen = new Set();
    return [].concat(turnsList).filter(Boolean).flatMap((t) => qa(S().generatedImage, t)).filter((img) => {
      const src = img.currentSrc || img.src;
      if (!src || seen.has(src)) return false;
      const big = (img.naturalWidth || img.width) >= 200 || (img.naturalHeight || img.height) >= 200;
      if (!big || !img.complete) return false;
      seen.add(src);
      return true;
    });
  }

  function detectError(turnsList) {
    const scopes = [...turnsList, ...qa(S().errorBanner)].filter(Boolean);
    for (const scope of scopes) {
      const text = (scope.innerText || '').toLowerCase();
      if (!text) continue;
      const hit = globalThis.CGA_ERROR_PATTERNS.find((p) => text.includes(p));
      if (hit && (!turnsList.includes(scope) || text.length < 600)) return hit;
    }
    return null;
  }

  function refusalIn(turnsList) {
    const text = flat(textOf(turnsList));
    if (!text) return null;
    return globalThis.CGA_REFUSAL_PATTERNS.find((p) => text.includes(p)) || null;
  }

  // ---- Typing, attaching, sending -----------------------------------------------------------

  async function setPrompt(text) {
    const el = await waitFor(composer, { timeout: 20000, label: 'the prompt box', stage: 'send' });
    el.focus();
    if (el.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    // Contenteditable (ProseMirror): clear, then paste (keeps newlines), fall back to insertText.
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

  async function dataUrlToFile({ name, dataUrl }) {
    const blob = await (await fetch(dataUrl)).blob();
    return new File([blob], name || 'image.png', { type: blob.type || 'image/png' });
  }

  async function attachFiles(files) {
    if (!files || !files.length) return;
    const list = await Promise.all(files.map(dataUrlToFile));
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
    // Give the upload time to start, then wait until no progress indicator is left in the
    // composer. (submit() also waits for Send to be enabled, which ChatGPT holds back until
    // uploads finish.) Spinners elsewhere on the page are ignored.
    await sleep(1000);
    await waitFor(() => !uploading(), { timeout: 120000, label: 'image upload', stage: 'send' });
  }

  function uploading() {
    const area = composerArea();
    return !!area && qa(S().uploadInProgress, area).some(visible);
  }

  function pressEnter(el) {
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
  }

  /**
   * Send what's in the composer and confirm it went out. A Stop button is never clicked as Send.
   * Confirmation = a new turn, ChatGPT replying, or the composer cleared; once any of those shows,
   * nothing is sent again.
   */
  async function submit(turnsBefore, { sendWaitMs = 30000 } = {}) {
    const box = composer();
    const sent = () => {
      if (isGenerating()) generationSeen = true;
      return generationSeen || turns().length > turnsBefore || !normalize(composerText(composer() || box));
    };
    const confirm = () => waitFor(sent, { timeout: 5000, interval: 150 }).then(() => true, () => false);

    const btn = await waitFor(() => {
      const b = findSend();
      return enabled(b) ? b : null;
    }, { timeout: sendWaitMs }).catch(() => null);
    if (btn) {
      btn.click();
      if (await confirm()) return 'button';
    }
    if (sent()) return 'button';
    const el = composer();
    if (!el) throw fail('Prompt box not found', 'send');
    pressEnter(el);
    if (await confirm()) return 'enter';
    // Last try: the send button may have appeared late.
    const late = findSend();
    if (enabled(late)) {
      late.click();
      if (await confirm()) return 'button';
    }
    throw fail('Could not send the prompt: no Send button was found', 'send');
  }

  // ---- Talking to the side panel ------------------------------------------------------------

  function notify(msg) {
    try {
      const p = ext?.runtime?.sendMessage?.(msg);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch { /* panel closed */ }
  }

  function progress(stage, extra = {}) {
    notify({ type: 'CGA_PROGRESS', stage, visibility: document.visibilityState, url: location.href, ...extra });
  }

  // Tell the side panel which conversation we're in as soon as ChatGPT assigns an id,
  // so an interruption mid-reply can still find its way back to this chat.
  let reportedUrl = '';
  function reportConversation() {
    if (!/\/c\/[\w-]+/.test(location.pathname) || location.href === reportedUrl) return;
    reportedUrl = location.href;
    notify({ type: 'CGA_CHAT_URL', url: location.href });
  }

  /**
   * Switch to an empty chat without reloading the page: nothing to do when the page is
   * already blank, otherwise click ChatGPT's own "New chat" control (client-side navigation).
   */
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

  function isConversationMissing() {
    const text = flat(document.body.innerText).slice(0, 4000);
    return ['conversation not found', 'unable to load conversation', "couldn't load conversation"].some((p) => text.includes(p));
  }

  /** What the driver can see on this page; shown by "Copy diagnostics" and after failures. */
  function diagnose() {
    const box = composer();
    const sendBtn = findSend();
    const stopBtn = findStop();
    const list = turns();
    const describe = (b) => b && {
      testid: b.getAttribute('data-testid') || '',
      id: b.id || '',
      type: b.getAttribute('type') || '',
      label: (b.getAttribute('aria-label') || '').slice(0, 40),
      enabled: enabled(b),
    };
    const last = list.slice(-4).map((t) => ({
      role: roleOf(t) || '?',
      markdown: !!q(S().markdown, t),
      actionBar: hasActionBar([t]),
      images: imagesIn([t]).length,
      chars: (t.innerText || '').length,
    }));
    return {
      url: location.href,
      pageLanguage: document.documentElement.lang || '',
      visibility: document.visibilityState,
      composer: box ? { found: true, selector: S().composer.find((s) => box.matches(s)) || '?', tag: box.tagName.toLowerCase(), role: box.getAttribute('role') || '' } : { found: false },
      composerButtons: controlCandidates().map((b) => `${buttonKind(b)}:${(b.getAttribute('aria-label') || b.getAttribute('data-testid') || '').slice(0, 30)}`),
      send: describe(sendBtn),
      stop: describe(stopBtn),
      generating: isGenerating(),
      turns: list.length,
      turnSelector: S().turn.find((s) => document.querySelector(s)) || 'role markers',
      lastTurns: last,
      userAgent: navigator.userAgent,
    };
  }

  // ---- One prompt, start to finish ----------------------------------------------------------

  // Where the current run is: unexpected errors before the prompt went out are 'send' errors.
  let phase = 'send';
  // Whether ChatGPT was seen generating since this prompt was sent (short replies can start and
  // finish between two checks, so submit() records it too).
  let generationSeen = false;

  const MIN_IMAGE_WAIT_MS = 4 * 60 * 1000;
  // After the reply text is done, an image that is still coming shows activity within this long.
  const IMAGE_ACTIVITY_MS = 30000;

  /** A finished text reply that asks something back ("Would you like it in landscape?"). */
  const asksQuestion = (text) => /[?？]\s*$/.test(String(text || '').trim());

  /**
   * Wait for the reply to `anchorPrompt` (the turn at or after `from` showing it) to finish.
   * Returns the reply turns. Throws 'reply' errors on timeout/stall, 'chatgpt' on ChatGPT errors.
   */
  async function collectReply({ anchorPrompt, from, deadline, expectImages, stableMs }) {
    let lastSig = '';
    let lastChange = Date.now();
    let stopSeen = generationSeen;
    let replying = false;
    let reply = [];
    while (true) {
      if (Date.now() >= deadline) throw fail('Timed out waiting for the reply', 'reply');
      await sleep(500);
      reportConversation();
      const generating = isGenerating();
      if (generating) stopSeen = true;
      reply = replyTurns(anchorPrompt, from);
      const text = textOf(reply);
      const imageCount = imagesIn(reply).length;
      const bar = hasActionBar(reply);
      if (!replying && (text || generating)) {
        replying = true;
        progress('replying');
      }
      if (!generating) {
        const err = detectError(reply);
        if (err) throw fail(`ChatGPT error: ${err}`, 'chatgpt');
      }
      const sig = `${reply.length}|${text.length}|${imageCount}|${generating}|${bar}`;
      if (sig !== lastSig) {
        lastSig = sig;
        lastChange = Date.now();
        continue;
      }
      const quiet = Date.now() - lastChange;
      const hasContent = !!(text || imageCount);
      if (!generating && quiet >= stableMs && (hasContent || (expectImages && reply.length))) {
        // Done when ChatGPT says so: the action bar, the Stop button we saw went away, or Send is
        // back. If none of these exist on this page, after a long quiet spell.
        if (bar || stopSeen || findSend() || quiet >= QUIET_FALLBACK_MS) return reply;
      }
      if (!generating && quiet >= STALL_MS) {
        throw fail(`ChatGPT stopped responding (nothing new for ${Math.round(STALL_MS / 60000)} min)`, 'reply');
      }
    }
  }

  /**
   * The reply's text is done but no image yet: wait for one until `deadline`.
   * Returns { images, reply } with images found, { refused } or { noImage } when ChatGPT is
   * clearly finished without one (a question or plain text). Throws a 'reply' error if it is
   * still working at the deadline, so the next attempt picks the image up instead of resending.
   */
  async function awaitImage({ anchorPrompt, from, deadline }) {
    progress('waitingForImage');
    let reply = replyTurns(anchorPrompt, from);
    let lastSig = '';
    let lastActivity = Date.now();
    while (Date.now() < deadline) {
      await sleep(1000);
      reply = replyTurns(anchorPrompt, from);
      const generating = isGenerating();
      let images = imagesIn(reply);
      if (images.length && !generating) {
        await sleep(3000); // let every image in the set finish loading
        reply = replyTurns(anchorPrompt, from);
        images = imagesIn(reply);
        return { images, reply };
      }
      if (!generating && refusalIn(reply)) return { refused: true, reply };
      const err = detectError(reply);
      if (err) throw fail(`ChatGPT error: ${err}`, 'chatgpt');
      const text = textOf(reply);
      const sig = `${reply.length}|${text.length}|${generating}`;
      if (sig !== lastSig || generating) {
        lastSig = sig;
        lastActivity = Date.now();
        continue;
      }
      // Finished without an image: the reply is closed off (action bar) or asks a question.
      const quiet = Date.now() - lastActivity;
      if (quiet >= 5000 && (hasActionBar(reply) || asksQuestion(text))) return { noImage: true, reply };
    }
    if (isGenerating() || Date.now() - lastActivity < IMAGE_ACTIVITY_MS) {
      throw fail('The image was still being generated when the time limit was reached', 'reply');
    }
    return { noImage: true, reply };
  }

  /** Type and send a message, returning the turn index replies are looked for after. */
  async function sendMessage(text, files = []) {
    await waitFor(() => !isGenerating(), { timeout: 90000, label: 'the previous reply to finish', stage: 'send' });
    phase = 'send';
    generationSeen = false;
    await attachFiles(files);
    await setPrompt(text);
    progress('typed');
    const from = turns().length;
    await submit(from, { sendWaitMs: files.length ? 120000 : 30000 });
    phase = 'reply';
    return from;
  }

  /**
   * Run one prompt: attach files, type, send, wait for completion, and extract results.
   * opts: { prompt, files:[{name,dataUrl}], expectImages, resumeIfSent, timeoutMs, stableMs, imageWaitMs }
   * resumeIfSent: if this exact prompt is already the latest one in the chat (the run was
   *   interrupted after sending), collect its reply instead of sending it a second time.
   * In image modes, if ChatGPT answers with a question or text instead of an image, one follow-up
   *   (CGA_IMAGE_NUDGE) is sent in the same chat before giving up.
   * Returns { text, images, url, resumed, nudged } or { refused: true, error, text, url } when
   * ChatGPT declined to generate the image. Errors carry .stage (see fail()).
   */
  async function run(opts) {
    const {
      prompt,
      files = [],
      expectImages = false,
      resumeIfSent = false,
      timeoutMs = 10 * 60 * 1000,
      stableMs = 2500,
      imageWaitMs = MIN_IMAGE_WAIT_MS,
    } = opts || {};
    if (!prompt) throw fail('Empty prompt', 'send');
    phase = 'send';
    generationSeen = false;
    const nudgeText = globalThis.CGA_IMAGE_NUDGE;

    let from = 0; // replies are looked for after the anchor turn at or after this index
    let anchorPrompt = prompt;
    let alreadySent = false;
    let nudged = false;
    if (resumeIfSent) {
      // Sent already if our prompt is one of the last two turns (followed by its reply, or with
      // ChatGPT still working on it). Also when the latest turns are our image nudge right
      // after our prompt.
      const count = turns().length;
      const sentAt = (text) => {
        const anchor = findAnchor(text, count - 2);
        return anchor !== -1 && anchor >= count - 2 && (anchor < count - 1 || isGenerating()) ? anchor : -1;
      };
      const own = sentAt(prompt);
      const nudge = expectImages && nudgeText ? sentAt(nudgeText) : -1;
      if (own !== -1) {
        from = own;
      } else if (nudge !== -1 && findAnchor(prompt, nudge - 2) !== -1 && findAnchor(prompt, nudge - 2) < nudge) {
        from = nudge;
        anchorPrompt = nudgeText;
        nudged = true;
      }
      alreadySent = own !== -1 || nudged;
      if (alreadySent) phase = 'reply';
    }

    if (!alreadySent) {
      from = await sendMessage(prompt, files);
      progress('sent');
    }

    const deadline = Date.now() + timeoutMs;
    let reply = await collectReply({ anchorPrompt, from, deadline, expectImages, stableMs });
    let images = imagesIn(reply);

    const refused = () => ({ refused: true, error: `Refused by ChatGPT: "${refusalIn(reply)}"`, text: textOf(reply), url: location.href });

    if (expectImages && !images.length) {
      if (refusalIn(reply)) return refused();
      // Wait for the image until the prompt's own time limit (at least imageWaitMs).
      const imageDeadline = () => Math.max(Date.now() + Math.min(imageWaitMs, MIN_IMAGE_WAIT_MS), deadline);
      let waited = await awaitImage({ anchorPrompt, from, deadline: Math.max(Date.now() + imageWaitMs, deadline) });
      if (waited.refused) { reply = waited.reply; return refused(); }
      if (waited.noImage && !nudged && nudgeText) {
        // ChatGPT asked something back or answered in text: ask once, in the same chat.
        nudged = true;
        progress('nudged');
        anchorPrompt = nudgeText;
        from = await sendMessage(nudgeText);
        reply = await collectReply({ anchorPrompt, from, deadline: imageDeadline(), expectImages, stableMs });
        images = imagesIn(reply);
        if (!images.length) {
          if (refusalIn(reply)) return refused();
          waited = await awaitImage({ anchorPrompt, from, deadline: imageDeadline() });
          if (waited.refused) { reply = waited.reply; return refused(); }
        }
      }
      if (!images.length) {
        reply = waited.reply || reply;
        images = waited.images || [];
      }
      if (!images.length) throw fail('No image was generated', 'chatgpt');
    }

    const text = textOf(reply);
    const saved = [];
    for (const img of images) saved.push(await imageToDataUrl(img));
    progress('done');
    return { text, images: saved, url: location.href, resumed: alreadySent, nudged };
  }

  /** Read a blob as a data: URL. */
  const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });

  /**
   * The image as a data: URL, or failing that its http(s) URL (the panel then saves it through
   * the browser's download manager, which needs no CORS). Never throws for a visible image.
   */
  async function imageToDataUrl(img) {
    const src = img.currentSrc || img.src;
    if (src.startsWith('data:')) return src;
    let sameOrigin = src.startsWith('blob:');
    try { sameOrigin = sameOrigin || new URL(src, location.href).origin === location.origin; } catch { /* keep */ }
    // Same origin: with cookies. Elsewhere (e.g. *.oaiusercontent.com signed URLs): without, so a
    // wildcard CORS answer is accepted.
    for (const credentials of sameOrigin ? ['include'] : ['omit', 'include']) {
      try {
        const res = await fetch(src, { credentials });
        if (res.ok) {
          const blob = await res.blob();
          if (blob.size) return await blobToDataUrl(blob);
        }
      } catch { /* try the next way */ }
    }
    try {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      return c.toDataURL('image/png'); // throws on a cross-origin ("tainted") image
    } catch { /* fall through */ }
    return new URL(src, location.href).href;
  }

  globalThis.__CGA_DRIVER = { run, setPrompt, attachFiles, isGenerating, diagnose, findSend, findStop, turns };

  if (ext?.runtime?.onMessage) {
    ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('CGA_')) return false;
      if (msg.type === 'CGA_PING') {
        sendResponse({
          ok: true,
          ready: !!composer(),
          url: location.href,
          missing: isConversationMissing(),
          visibility: document.visibilityState,
          loadedAt: performance.timeOrigin, // when this page load started (tells a fresh page from the old one)
        });
        return false;
      }
      if (msg.type === 'CGA_DIAGNOSE') {
        let snapshot;
        try { snapshot = diagnose(); } catch (e) { snapshot = { error: String(e?.message || e) }; }
        sendResponse({ ok: true, diagnostics: snapshot });
        return false;
      }
      if (msg.type === 'CGA_NEW_CHAT') {
        newChat().then((ok) => sendResponse({ ok, url: location.href }));
        return true;
      }
      if (msg.type === 'CGA_STOP') {
        const stop = findStop();
        if (stop) stop.click();
        sendResponse({ ok: true });
        return false;
      }
      if (msg.type === 'CGA_RUN') {
        run(msg.payload)
          .then((result) => sendResponse({ ok: !result.refused, ...result }))
          .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e), stage: e?.stage || phase }));
        return true; // async response
      }
      return false;
    });
  }
})();
