// Content script for chatgpt.com. Drives one prompt at a time on request from the side panel.
// Classic script (content scripts cannot be ES modules); guarded so re-injection is harmless.
(() => {
  if (globalThis.__CGA_DRIVER) return;

  const S = () => globalThis.CGA_SELECTORS;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  async function waitFor(fn, { timeout = 30000, interval = 250, label = 'condition' } = {}) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(interval);
    }
    throw new Error(`Timed out waiting for ${label}`);
  }

  function composer() {
    return q(S().composer);
  }

  function sendButton() {
    return q(S().sendButton);
  }

  function isGenerating() {
    const stop = q(S().stopButton);
    return !!stop && visible(stop);
  }

  function turns() {
    const t = qa(S().turn);
    if (t.length) return t;
    return qa([S().userMessage, S().assistantMessage]);
  }

  function lastAssistantTurn() {
    const list = turns();
    for (let i = list.length - 1; i >= 0; i--) {
      const el = list[i];
      if (el.matches(S().userMessage) || el.querySelector(S().userMessage)) {
        if (!el.querySelector(S().assistantMessage)) return null;
      }
      if (el.matches(S().assistantMessage) || el.querySelector(S().assistantMessage) || el.querySelector('img')) return el;
    }
    return null;
  }

  function composerText(el) {
    return el.tagName === 'TEXTAREA' ? el.value : el.innerText;
  }

  async function setPrompt(text) {
    const el = await waitFor(composer, { timeout: 20000, label: 'the prompt box' });
    el.focus();
    if (el.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    // ProseMirror contenteditable: clear, then paste (keeps newlines), fall back to insertText.
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await sleep(150);
    if (normalize(composerText(el)) !== normalize(text)) {
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
    await sleep(150);
    if (!normalize(composerText(el))) throw new Error('Could not type the prompt');
  }

  const normalize = (s) => String(s || '').replace(/\s+/g, ' ').trim();

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
    // Give the upload time to start, then wait until it's finished and send is possible.
    await sleep(1500);
    await waitFor(() => !q(S().uploadInProgress), { timeout: 120000, label: 'image upload' });
  }

  async function clickSend() {
    const btn = await waitFor(() => {
      const b = sendButton();
      return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true' ? b : null;
    }, { timeout: 60000, label: 'the send button' }).catch(() => null);
    if (btn) {
      btn.click();
      return;
    }
    const el = composer();
    if (!el) throw new Error('Prompt box not found');
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
  }

  function detectError(root) {
    const scopes = [root, ...qa(S().errorBanner)].filter(Boolean);
    for (const scope of scopes) {
      const text = (scope.innerText || '').toLowerCase();
      if (!text) continue;
      const hit = globalThis.CGA_ERROR_PATTERNS.find((p) => text.includes(p));
      if (hit && (scope !== root || text.length < 600)) return hit;
    }
    return null;
  }

  function assistantText(turn) {
    if (!turn) return '';
    const msgs = turn.matches(S().assistantMessage) ? [turn] : qa(S().assistantMessage, turn);
    return msgs
      .map((m) => {
        const md = q(S().markdown, m);
        return (md || m).innerText.trim();
      })
      .filter(Boolean)
      .join('\n\n');
  }

  function imagesIn(turn) {
    if (!turn) return [];
    const seen = new Set();
    return qa(S().generatedImage, turn).filter((img) => {
      const src = img.currentSrc || img.src;
      if (!src || seen.has(src)) return false;
      const big = (img.naturalWidth || img.width) >= 200 || (img.naturalHeight || img.height) >= 200;
      if (!big || !img.complete) return false;
      seen.add(src);
      return true;
    });
  }

  async function imageToDataUrl(img) {
    const src = img.currentSrc || img.src;
    try {
      const blob = await (await fetch(src, { credentials: 'include' })).blob();
      return await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = reject;
        r.readAsDataURL(blob);
      });
    } catch {
      // Cross-origin without CORS: try drawing to a canvas (works when the image isn't tainted).
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      return c.toDataURL('image/png');
    }
  }

  function lastUserText() {
    const users = qa(S().userMessage);
    const last = users[users.length - 1];
    return last ? last.innerText : '';
  }

  // Curly apostrophes etc. so "can’t" matches "can't".
  const flat = (s) => normalize(s).toLowerCase().replace(/[\u2018\u2019\u02bc]/g, "'");

  function refusalIn(turn) {
    const text = flat(assistantText(turn));
    if (!text) return null;
    return globalThis.CGA_REFUSAL_PATTERNS.find((p) => text.includes(p)) || null;
  }

  // Tell the side panel which conversation we're in as soon as ChatGPT assigns an id,
  // so an interruption mid-reply can still find its way back to this chat.
  let reportedUrl = '';
  function reportConversation() {
    if (!/\/c\/[\w-]+/.test(location.pathname) || location.href === reportedUrl) return;
    reportedUrl = location.href;
    if (globalThis.chrome?.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: 'CGA_CHAT_URL', url: location.href }).catch(() => {});
    }
  }

  function isConversationMissing() {
    const text = flat(document.body.innerText).slice(0, 4000);
    return ['conversation not found', 'unable to load conversation', "couldn't load conversation"].some((p) => text.includes(p));
  }

  /**
   * Run one prompt: attach files, type, send, wait for completion, and extract results.
   * opts: { prompt, files:[{name,dataUrl}], expectImages, resumeIfSent, timeoutMs, stableMs, imageWaitMs }
   * resumeIfSent: if this exact prompt is already the last message in the chat (the run was
   *   interrupted after sending), collect its reply instead of sending it a second time.
   * Returns { text, images, url, resumed } or { refused: true, error, text, url } when ChatGPT
   * declined to generate the image.
   */
  async function run(opts) {
    const {
      prompt,
      files = [],
      expectImages = false,
      resumeIfSent = false,
      timeoutMs = 10 * 60 * 1000,
      stableMs = 2500,
      imageWaitMs = 4 * 60 * 1000,
    } = opts || {};
    if (!prompt) throw new Error('Empty prompt');

    const alreadySent = resumeIfSent
      && flat(lastUserText()) === flat(prompt)
      && (!!lastAssistantTurn() || isGenerating());

    let prevAssistant = null;
    if (!alreadySent) {
      await waitFor(() => !isGenerating(), { timeout: 60000, label: 'the previous reply to finish' });
      const before = turns().length;
      prevAssistant = lastAssistantTurn();

      await attachFiles(files);
      await setPrompt(prompt);
      await clickSend();

      // Wait for the reply to start (a new turn or the stop button).
      await waitFor(() => turns().length > before || isGenerating(), { timeout: 60000, label: 'ChatGPT to start replying' });
    }

    const deadline = Date.now() + timeoutMs;
    let lastSig = '';
    let stableSince = Date.now();
    let turn = null;
    while (Date.now() < deadline) {
      await sleep(500);
      reportConversation();
      turn = lastAssistantTurn();
      if (turn === prevAssistant) turn = null;
      const err = detectError(turn);
      if (err && !isGenerating()) throw new Error(`ChatGPT error: ${err}`);
      const sig = `${assistantText(turn).length}|${imagesIn(turn).length}|${isGenerating()}`;
      if (sig !== lastSig) {
        lastSig = sig;
        stableSince = Date.now();
        continue;
      }
      if (!isGenerating() && turn && Date.now() - stableSince >= stableMs) break;
    }
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the reply');

    const refused = () => ({ refused: true, error: `Refused by ChatGPT: "${refusalIn(turn)}"`, text: assistantText(turn), url: location.href });

    let images = imagesIn(turn);
    if (expectImages && !images.length) {
      if (refusalIn(turn)) return refused();
      const imgDeadline = Date.now() + imageWaitMs;
      while (Date.now() < imgDeadline) {
        await sleep(1000);
        turn = lastAssistantTurn() || turn;
        images = imagesIn(turn);
        if (images.length && !isGenerating()) {
          await sleep(3000); // let every image in the set finish loading
          images = imagesIn(lastAssistantTurn() || turn);
          break;
        }
        if (!isGenerating() && refusalIn(turn)) return refused();
        const err = detectError(turn);
        if (err) throw new Error(`ChatGPT error: ${err}`);
      }
      if (!images.length) throw new Error('No image was generated');
    }

    const text = assistantText(turn);
    const dataUrls = [];
    for (const img of images) dataUrls.push(await imageToDataUrl(img));
    return { text, images: dataUrls, url: location.href, resumed: alreadySent };
  }

  globalThis.__CGA_DRIVER = { run, setPrompt, attachFiles, isGenerating, lastAssistantTurn, assistantText, imagesIn };

  if (globalThis.chrome && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('CGA_')) return false;
      if (msg.type === 'CGA_PING') {
        sendResponse({ ok: true, ready: !!composer(), url: location.href, missing: isConversationMissing() });
        return false;
      }
      if (msg.type === 'CGA_STOP') {
        const stop = q(S().stopButton);
        if (stop) stop.click();
        sendResponse({ ok: true });
        return false;
      }
      if (msg.type === 'CGA_RUN') {
        run(msg.payload)
          .then((result) => sendResponse({ ok: !result.refused, ...result }))
          .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
        return true; // async response
      }
      return false;
    });
  }
})();
