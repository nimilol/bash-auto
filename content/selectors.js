// What agent.js knows about chatgpt.com's page: DOM selectors, button labels in many languages,
// and the phrases that mean an error or a refusal.
// The page is only used to type and send prompts. Whether a reply is finished, and what it
// contains, comes from ChatGPT's own backend (net-hook.js + conversation.js). The selectors below
// that are about replies are a fallback for when the backend can't be read.
//
// Nothing depends on a single selector: every list is tried in order, and buttons are recognized
// by test id, then by label (any language below), then by icon or type.
globalThis.CGA_SELECTORS = {
  newChatButton: ['[data-testid="create-new-chat-button"]', 'a[href="/"][data-discover]', 'button[aria-label*="New chat"]', 'a[aria-label*="New chat"]', 'nav a[href="/"]'],
  // Sept 2026: the composer is a bare contenteditable role="textbox" (no #prompt-textarea).
  composer: ['#prompt-textarea', 'div[contenteditable="true"].ProseMirror', 'div[contenteditable="true"][role="textbox"]', 'form [contenteditable="true"]', 'textarea[name="prompt-textarea"]', 'form textarea'],
  // Known send controls. Since Sept 2026 the send button may have no test id at all; the driver
  // then looks for a button[type=submit] or a send label in the composer's form.
  sendButton: ['[data-testid="send-button"]', '[data-testid="fruitjuice-send-button"]', 'button[data-testid*="send"]', 'button[aria-label="Send prompt"]', 'form button[type="submit"]'],
  // Send, Stop and Voice can share this one slot; its state is read, never assumed.
  submitSlot: ['#composer-submit-button', '[data-testid="composer-submit-button"]'],
  // Known stop controls anywhere on the page. Translated labels and the square icon are checked
  // on the composer's own buttons (see CGA_LABELS.stop and stopIconPaths).
  stopButton: ['[data-testid="stop-button"]', 'button[aria-label="Stop streaming"]', 'button[aria-label="Stop generating"]'],
  // Stop is drawn as a rounded square: one path starting like this (or a lone <rect>).
  stopIconPaths: ['M4.5 5.75'],
  fileInput: ['input[type="file"][accept*="image"]', 'input[type="file"]'],
  // Conversation turns. The first selector that matches anything wins.
  turn: ['article[data-testid^="conversation-turn"]', '[data-testid^="conversation-turn"]', 'article[data-turn]', '[data-turn]', 'main article'],
  userMessage: '[data-message-author-role="user"]',
  assistantMessage: '[data-message-author-role="assistant"]',
  // Reply body. Sept 2026 replies use a CSS-module class: MarkdownRoot-<hash>.
  markdown: ['.markdown', '[class*="MarkdownRoot"]', '[class*="markdown" i]'],
  // Shown under a reply only once it is finished.
  actionBar: ['[data-testid="copy-turn-action-button"]', '[data-testid*="turn-action"]', '[data-testid="good-response-turn-action-button"]'],
  // Images produced by ChatGPT (DALL·E / native image generation).
  generatedImage: ['img[src*="oaiusercontent"]', 'img[src*="backend-api/estuary"]', 'img[src*="/backend-api/"]', 'img[src^="blob:"]', 'img[alt*="enerated"]'],
  // Upload progress, looked for only inside the composer (spinners elsewhere on the page don't
  // count). ChatGPT also keeps Send disabled until uploads finish, which the driver waits for.
  uploadInProgress: ['[role="progressbar"]', 'svg[class*="animate-spin"]', '[class*="animate-spin"]'],
  errorBanner: ['[data-testid="error"]', '.text-token-text-error', 'div[class*="text-red"]', '[role="alert"]'],
};

// Lower-cased button labels in the languages ChatGPT ships. A label matches when it contains one
// of these. Add a word here when a user reports a language that isn't recognized.
globalThis.CGA_LABELS = {
  stop: [
    'stop', 'detener', 'dừng', '停止', '中止', '중지', '멈추', 'durdur', 'arrêter', 'arreter', 'anhalten',
    'interrompi', 'parar', 'interromper', 'остановить', 'зупинити', 'zatrzymaj', 'hentikan', 'berhenti',
    'หยุด', 'إيقاف', 'עצור', 'रोकें', 'zastavit', 'leállít', 'opreș', 'σταμάτ', 'lopeta', 'avbryt',
  ],
  send: [
    'send', 'enviar', 'gửi', '发送', '傳送', '送出', '送信', '보내기', '전송', 'gönder', 'envoyer', 'senden',
    'invia', 'отправить', 'надіслати', 'wyślij', 'kirim', 'ส่ง', 'إرسال', 'שלח', 'भेजें', 'odeslat',
    'verzenden', 'verstuur', 'skicka', 'lähetä', 'küld', 'trimite', 'αποστολή',
  ],
  copy: [
    'copy', 'copiar', 'sao chép', '复制', '複製', 'コピー', '복사', 'kopyala', 'copier', 'kopieren', 'copia',
    'копировать', 'копіювати', 'kopiuj', 'salin', 'คัดลอก', 'نسخ', 'העתק', 'कॉपी', 'kopírovat', 'kopiëren',
    'kopiera', 'kopioi', 'másol', 'copiază', 'αντιγραφή',
  ],
};

// Lower-cased fragments that mean the run failed and should be retried.
globalThis.CGA_ERROR_PATTERNS = [
  'something went wrong',
  'network error',
  'rate limit',
  "you've reached",
  'you have reached',
  'too many requests',
  'usage cap',
  'error generating',
  'an error occurred',
  'please try again later',
];

// Lower-cased fragments that mean ChatGPT declined to make an image (policy refusal).
// Only checked when an image was expected and none came back.
globalThis.CGA_REFUSAL_PATTERNS = [
  'content policy',
  'content policies',
  'violates our',
  'violate our',
  'against our policies',
  'usage policies',
  "i can't create",
  "i can't generate",
  "i can't make",
  "i can't help with",
  "i can't assist",
  'i cannot create',
  'i cannot generate',
  "i'm unable to create",
  "i'm unable to generate",
  "i'm not able to create",
  "i'm not able to generate",
  'unable to generate that image',
  "wasn't able to generate",
  'not able to create',
  "can't be generated",
];

// Sent once, in the same chat, when an image was asked for but ChatGPT replied with a question or
// plain text instead of drawing. Edit freely; keep it short.
globalThis.CGA_IMAGE_NUDGE = 'Yes, please generate the image now, exactly as described.';
