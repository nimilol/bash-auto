// What the extension knows about chatgpt.com's page: selectors, button labels in many languages,
// and readers for the reply area (text, images, progress indicators, errors).
// The page is used to type and send prompts, and as one of three signals for "is it done?"
// (with the reply stream and ChatGPT's conversation data). No single selector is relied on:
// every list is tried in order, and buttons are recognized by test id, then label, then icon.
(() => {
  const SEL = {
    newChat: ['[data-testid="create-new-chat-button"]', 'a[href="/"][data-discover]', 'button[aria-label*="New chat" i]', 'a[aria-label*="New chat" i]', 'nav a[href="/"]'],
    composer: ['#prompt-textarea', 'div[contenteditable="true"].ProseMirror', 'div[contenteditable="true"][role="textbox"]', 'form [contenteditable="true"]', 'textarea[name="prompt-textarea"]', 'form textarea'],
    send: ['[data-testid="send-button"]', '[data-testid="fruitjuice-send-button"]', 'button[data-testid*="send"]', 'button[aria-label="Send prompt"]', 'form button[type="submit"]'],
    submitSlot: ['#composer-submit-button', '[data-testid="composer-submit-button"]'],
    stop: ['[data-testid="stop-button"]', 'button[aria-label="Stop streaming"]', 'button[aria-label="Stop generating"]'],
    stopIconPaths: ['M4.5 5.75'],
    fileInput: ['input[type="file"][accept*="image"]', 'input[type="file"]'],
    turn: ['article[data-testid^="conversation-turn"]', '[data-testid^="conversation-turn"]', 'article[data-turn]', '[data-turn]', 'main article'],
    userMessage: '[data-message-author-role="user"]',
    assistantMessage: '[data-message-author-role="assistant"]',
    markdown: ['.markdown', '[class*="MarkdownRoot"]', '[class*="markdown" i]'],
    actionBar: ['[data-testid="copy-turn-action-button"]', '[data-testid*="turn-action"]', '[data-testid="good-response-turn-action-button"]'],
    // Anything in a reply that means "still being made".
    working: ['[role="progressbar"]', '[class*="animate-pulse"]', '[class*="shimmer" i]', '[class*="loading-shimmer"]', '[data-testid*="image-gen-loading"]', '[aria-busy="true"]'],
    uploadInProgress: ['[role="progressbar"]', 'svg[class*="animate-spin"]', '[class*="animate-spin"]'],
    errorBanner: ['[data-testid="error"]', '.text-token-text-error', '[class*="text-red"]', '[role="alert"]'],
    loginButton: ['[data-testid="login-button"]', 'button[data-testid*="login"]', 'a[href*="/auth/login"]'],
  };

  const LABELS = {
    stop: ['stop', 'detener', 'dừng', '停止', '中止', '중지', '멈추', 'durdur', 'arrêter', 'arreter', 'anhalten', 'interrompi', 'parar',
      'interromper', 'остановить', 'зупинити', 'zatrzymaj', 'hentikan', 'berhenti', 'หยุด', 'إيقاف', 'עצור', 'रोकें', 'zastavit', 'leállít',
      'opreș', 'σταμάτ', 'lopeta', 'avbryt'],
    send: ['send', 'enviar', 'gửi', '发送', '傳送', '送出', '送信', '보내기', '전송', 'gönder', 'envoyer', 'senden', 'invia', 'отправить',
      'надіслати', 'wyślij', 'kirim', 'ส่ง', 'إرسال', 'שלח', 'भेजें', 'odeslat', 'verzenden', 'verstuur', 'skicka', 'lähetä', 'küld', 'trimite', 'αποστολή'],
    copy: ['copy', 'copiar', 'sao chép', '复制', '複製', 'コピー', '복사', 'kopyala', 'copier', 'kopieren', 'copia', 'копировать', 'копіювати',
      'kopiuj', 'salin', 'คัดลอก', 'نسخ', 'העתק', 'कॉपी', 'kopírovat', 'kopiëren', 'kopiera', 'kopioi', 'másol', 'copiază', 'αντιγραφή'],
    retry: ['retry', 'regenerate', 'try again', 'reintentar', 'thử lại', '重试', '重新生成', '再試行', '다시 시도', 'réessayer', 'erneut'],
  };

  const ERRORS = ['something went wrong', 'network error', 'rate limit', "you've reached", 'you have reached', 'too many requests',
    'usage cap', 'error generating', 'an error occurred', 'please try again later', 'there was an error', 'conversation not found',
    'hmm...something seems to have gone wrong'];

  const WORKING_TEXT = /creating image|generating image|processing image|image is being (created|generated)|lots of people are creating images|getting started/i;

  const normalize = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const flat = (s) => normalize(s).toLowerCase().replace(/[‘’ʼ]/g, "'");

  function qa(list, root = document) {
    const out = new Set();
    for (const sel of [].concat(list)) {
      try { root.querySelectorAll(sel).forEach((el) => out.add(el)); } catch { /* bad selector */ }
    }
    return [...out];
  }
  const q = (list, root = document) => qa(list, root)[0] || null;
  const outermost = (els) => els.filter((el) => !els.some((o) => o !== el && o.contains(el)));

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function composer() {
    for (const sel of SEL.composer) {
      const all = [...document.querySelectorAll(sel)];
      const el = all.find(visible) || all[0];
      if (el) return el;
    }
    return null;
  }

  const composerText = (el) => (el ? (el.tagName === 'TEXTAREA' ? el.value : el.innerText) : '');

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
    return SEL.stopIconPaths.some((p) => d.startsWith(p));
  }

  /** 'stop' | 'send' | 'other' */
  function buttonKind(btn) {
    const id = (btn.getAttribute('data-testid') || '').toLowerCase();
    if (id.includes('stop')) return 'stop';
    if (/speech|voice|dictat|mic/.test(id)) return 'other';
    if (id.includes('send')) return 'send';
    const text = label(btn);
    if (text && LABELS.stop.some((w) => text.includes(w))) return 'stop';
    if (text && LABELS.send.some((w) => text.includes(w))) return 'send';
    if (hasStopIcon(btn)) return 'stop';
    if ((btn.getAttribute('type') || '').toLowerCase() === 'submit') return 'send';
    return 'other';
  }

  function controlCandidates() {
    const area = composerArea();
    const known = qa([...SEL.submitSlot, ...SEL.send, ...SEL.stop]);
    const local = area ? [...area.querySelectorAll('button')] : [];
    return [...new Set([...known, ...local])].filter(visible);
  }

  const findStop = () => qa(SEL.stop).find(visible) || controlCandidates().find((b) => buttonKind(b) === 'stop') || null;
  const findSend = () => controlCandidates().find((b) => buttonKind(b) === 'send') || null;
  const enabled = (b) => !!b && !b.disabled && b.getAttribute('aria-disabled') !== 'true';

  function turns() {
    for (const sel of SEL.turn) {
      const els = outermost([...document.querySelectorAll(sel)]);
      if (els.length) return els;
    }
    return outermost(qa([SEL.userMessage, SEL.assistantMessage]));
  }

  function roleOf(turn) {
    const own = turn.getAttribute('data-turn') || turn.getAttribute('data-message-author-role');
    if (own === 'user' || own === 'assistant') return own;
    if (turn.querySelector(SEL.userMessage)) return 'user';
    if (turn.querySelector(SEL.assistantMessage)) return 'assistant';
    return q(SEL.markdown, turn) ? 'assistant' : null;
  }

  function showsText(turn, text) {
    if (roleOf(turn) === 'assistant') return false;
    const head = flat(text).slice(0, 80);
    return !!head && flat(turn.innerText).includes(head);
  }

  /** The reply turns after the latest turn showing the prompt, up to the next prompt that isn't ours. */
  function replyTurns(prompt, followUps = []) {
    const list = turns();
    let at = -1;
    for (let i = list.length - 1; i >= 0; i--) if (showsText(list[i], prompt)) { at = i; break; }
    if (at === -1) return { found: false, turns: [] };
    const out = [];
    for (const t of list.slice(at + 1)) {
      if (roleOf(t) === 'user') {
        if (followUps.some((f) => showsText(t, f))) continue;
        break;
      }
      out.push(t);
    }
    return { found: true, turns: out };
  }

  function textOf(list) {
    return list.map((t) => {
      const mds = outermost(qa(SEL.markdown, t));
      if (mds.length) return mds.map((m) => m.innerText.trim()).filter(Boolean).join('\n\n');
      const clone = t.cloneNode(true);
      clone.querySelectorAll('button, [role="button"], svg, img').forEach((b) => b.remove());
      return clone.innerText.trim();
    }).filter(Boolean).join('\n\n');
  }

  const hasActionBar = (list) => list.some((t) => q(SEL.actionBar, t)
    || [...t.querySelectorAll('button')].some((b) => LABELS.copy.some((w) => label(b).includes(w))));

  const srcOf = (img) => img.currentSrc || img.src || '';

  /** Blurred, invisible or half-drawn: a preview of an image still being made. */
  function isPreview(img) {
    let node = img;
    for (let i = 0; i < 5 && node && node !== document.body; i++, node = node.parentElement) {
      const style = getComputedStyle(node);
      if (Number(style.opacity) < 0.05) return true;
      const blur = /blur\(\s*([\d.]+)/.exec(style.filter || '');
      if (blur && Number(blur[1]) > 0) return true;
    }
    return false;
  }

  const isBig = (img) => Math.max(img.naturalWidth || 0, img.width || 0) >= 200 || Math.max(img.naturalHeight || 0, img.height || 0) >= 200;

  /** Finished, full-size images in the reply turns, not seen before the prompt was sent. */
  function replyImages(list, baseline) {
    const seen = new Set();
    const out = [];
    for (const img of list.flatMap((t) => [...t.querySelectorAll('img')])) {
      const src = srcOf(img);
      if (!src || seen.has(src) || baseline?.has(src)) continue;
      if (!img.complete || !img.naturalWidth || !isBig(img) || isPreview(img)) continue;
      seen.add(src);
      out.push(img);
    }
    return out;
  }

  /** Something in the reply says it's still being made. */
  function generating(list) {
    for (const t of list) {
      if (qa(SEL.working, t).some(visible)) return true;
      if (WORKING_TEXT.test(t.innerText || '')) return true;
      if ([...t.querySelectorAll('img')].some((img) => isBig(img) && (!img.complete || isPreview(img)))) return true;
    }
    return false;
  }

  /** An error message in the reply turns (and, with banners, in error banners anywhere). */
  function errorIn(list, banners = true) {
    const scopes = [...list, ...(banners ? qa(SEL.errorBanner).filter(visible) : [])];
    for (const scope of scopes) {
      const text = flat(scope.innerText);
      if (!text || (list.includes(scope) && text.length > 600)) continue;
      const hit = ERRORS.find((p) => text.includes(p));
      if (hit) return hit;
    }
    return '';
  }

  /** Every image on the page outside the composer (the baseline before sending). */
  function allImageSrcs() {
    const area = composerArea();
    return [...document.querySelectorAll('main img, [data-turn] img, article img')].filter((img) => !area?.contains(img)).map(srcOf).filter(Boolean);
  }

  /** The page's view of one prompt: used by the decision as the "page" signal. */
  function readReply(prompt, { baseline, followUps = [] } = {}) {
    const { found, turns: list } = replyTurns(prompt, followUps);
    const imgs = found ? replyImages(list, baseline) : [];
    return {
      promptShown: found,
      text: found ? textOf(list) : '',
      images: imgs.length,
      imageEls: imgs,
      generating: found && generating(list),
      stop: !!findStop(),
      actionBar: found && hasActionBar(list),
      error: found ? errorIn(list) : '',
      replyError: found ? errorIn(list, false) : '',
      signature: found ? `${list.length}|${textOf(list).length}|${imgs.map(srcOf).join(' ')}|${generating(list)}` : 'none',
    };
  }

  function loginNeeded() {
    if (composer()) return false;
    return !!qa(SEL.loginButton).find(visible) || /\/auth\/login|\/log-?in/.test(location.pathname);
  }

  globalThis.CGA_DOM = {
    SEL, LABELS, composer, composerText, composerArea, findSend, findStop, enabled, turns, roleOf, replyTurns,
    readReply, allImageSrcs, srcOf, visible, qa, q, loginNeeded, normalize, flat, showsText, errorIn,
  };
})();
