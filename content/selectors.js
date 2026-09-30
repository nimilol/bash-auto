// Every chatgpt.com DOM selector used by the driver lives here.
// When ChatGPT ships a UI change, this is usually the only file that needs patching.
globalThis.CGA_SELECTORS = {
  newChatButton: ['[data-testid="create-new-chat-button"]', 'a[href="/"][data-discover]', 'button[aria-label*="New chat"]', 'a[aria-label*="New chat"]', 'nav a[href="/"]'],
  composer: ['#prompt-textarea', 'div[contenteditable="true"].ProseMirror', 'textarea[name="prompt-textarea"]', 'form textarea'],
  sendButton: ['[data-testid="send-button"]', 'button[aria-label="Send prompt"]', 'button[aria-label*="Send"]', '#composer-submit-button'],
  stopButton: ['[data-testid="stop-button"]', 'button[aria-label="Stop streaming"]', 'button[aria-label*="Stop"]'],
  fileInput: ['input[type="file"][accept*="image"]', 'input[type="file"]'],
  turn: ['article[data-testid^="conversation-turn"]', '[data-testid^="conversation-turn"]'],
  userMessage: '[data-message-author-role="user"]',
  assistantMessage: '[data-message-author-role="assistant"]',
  markdown: ['.markdown', '[class*="markdown"]'],
  // Images produced by ChatGPT (DALL·E / native image generation).
  generatedImage: ['img[src*="oaiusercontent"]', 'img[src*="backend-api/estuary"]', 'img[src*="/backend-api/"]', 'img[src^="blob:"]', 'img[alt*="enerated"]'],
  uploadInProgress: ['[role="progressbar"]', 'circle[stroke-dasharray]'],
  errorBanner: ['[data-testid="error"]', '.text-token-text-error', 'div[class*="text-red"]', '[role="alert"]'],
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
