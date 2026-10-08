// End-to-end test with Playwright + Chromium, with https://chatgpt.com routed to tests/mock-chatgpt.html.
// Everything runs against both page layouts the mock can show: the original one and the Sept 2026
// redesign (no test ids or role markers, localized or unknown button labels, Send/Stop in one slot,
// silent "Thinking" before each reply) that made the queue stall after the first prompt.
//  1. content/driver.js on its own: text, image, attachment, error, policy refusal, resume without resend,
//     several prompts in a row, and never clicking Stop or Voice as Send
//  2. the real unpacked extension driven from its side panel:
//     - text queue with retry + failure, downloads, language switching
//     - image queue kept in ONE chat, with a refused prompt retried then skipped
//     - interruption (ChatGPT tab navigated away mid-reply) -> returns to the session chat, no resend
//     - side panel reopened mid-reply -> resumes in the same chat, no resend
//     - ChatGPT tab in the background when a prompt starts -> brought to the front
// Run: npm run test:e2e   (needs the `playwright` package; set CHROMIUM_PATH to override the browser)
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mockHtml = readFileSync(join(root, 'tests/mock-chatgpt.html'), 'utf8');
const CHAT_ROUTE = /^https:\/\/(chatgpt\.com|chat\.openai\.com)\/.*/;
const mockRoute = (route) => route.fulfill({ status: 200, contentType: 'text/html', body: mockHtml });
const OTHER_ROUTE = /^https:\/\/example\.org\/.*/;
const otherRoute = (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Other</title><p>Another site</p>' });
// The mock's Stop control in either layout (test-only hooks; the extension doesn't use these).
const STOP_SELECTOR = '[data-testid="stop-button"], button[data-mode="stop"]';
const LAYOUTS = [
  { name: 'legacy layout', query: '?ui=legacy' },
  { name: '2026 layout, Turkish labels', query: '?ui=2026&lang=tr' },
];

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    const globalRoot = execSync('npm root -g').toString().trim();
    return await import(pathToFileURL(join(globalRoot, 'playwright', 'index.mjs')).href);
  }
}

const { chromium } = await loadPlaywright();
const launchOpts = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {};

async function testDriver({ name, query, thinkMs = 1500 }) {
  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext();
  await context.route(CHAT_ROUTE, mockRoute);
  const page = await context.newPage();
  const inject = async () => {
    await page.addScriptTag({ path: join(root, 'content/selectors.js') });
    await page.addScriptTag({ path: join(root, 'content/driver.js') });
  };
  await page.goto(`https://chatgpt.com/${query}`);
  await page.evaluate((ms) => localStorage.setItem('thinkMs', String(ms)), thinkMs);
  await page.reload();
  await inject();

  const run = (opts) => page.evaluate((o) => globalThis.__CGA_DRIVER.run(o).catch((e) => ({ error: e.message })), { stableMs: 400, ...opts });

  const text = await run({ prompt: 'hello there\nsecond line' });
  assert.match(text.text, /^Echo: hello there/);
  assert.deepEqual(text.images, []);
  assert.match(text.url, /\/c\/mock-/);

  // Several prompts in a row: each reply is collected and the next prompt goes out (the reported bug).
  for (const n of [1, 2, 3]) {
    const r = await run({ prompt: `follow-up number ${n}` });
    assert.equal(r.text, `Echo: follow-up number ${n}`, `${name}: reply ${n}`);
  }

  const img = await run({ prompt: 'draw an image of a cat', expectImages: true });
  assert.equal(img.images.length, 1);
  assert.match(img.images[0], /^data:image\/png;base64,/);

  const dot = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const withFile = await run({ prompt: 'describe', files: [{ name: 'alice.png', dataUrl: dot }] });
  assert.match(withFile.text, /\[files: alice\.png\]/);

  const failed = await run({ prompt: 'please fail' });
  assert.match(failed.error, /something went wrong/i);

  const refused = await run({ prompt: 'a forbidden image', expectImages: true });
  assert.equal(refused.refused, true);
  assert.match(refused.error, /Refused by ChatGPT/);

  // Resume: the last prompt is already in the chat (page reloaded) -> collect, don't resend.
  await page.reload();
  await inject();
  await page.waitForSelector('main article:nth-child(2)');
  const sentBefore = await page.evaluate(() => JSON.parse(localStorage.getItem('sent')).length);
  const resumed = await run({ prompt: 'a forbidden image', expectImages: true, resumeIfSent: true });
  assert.equal(resumed.refused, true);
  const again = await run({ prompt: 'a forbidden image', expectImages: true, resumeIfSent: false });
  assert.equal(again.refused, true);
  const sentAfter = await page.evaluate(() => JSON.parse(localStorage.getItem('sent')).length);
  assert.equal(sentAfter - sentBefore, 1, 'resumeIfSent must not resend; a normal run must');

  const sent = await page.evaluate(() => JSON.parse(localStorage.getItem('sent')));
  assert.equal(new Set(sent).size, sent.length - 1, `${name}: only the deliberate resend is a duplicate: ${sent}`);
  const misclicks = await page.evaluate(() => [localStorage.getItem('wrongClicks'), localStorage.getItem('stoppedReplies')]);
  assert.deepEqual(misclicks, [null, null], `${name}: never clicked Voice/Dictation or Stop`);

  await browser.close();
  console.log(`ok - driver, ${name}: text, 3 in a row, image, files, error, refusal, resume`);
}

/** The driver sees what it needs even when it knows none of the button labels. */
async function testDriverUnknownLabels() {
  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext();
  await context.route(CHAT_ROUTE, mockRoute);
  const page = await context.newPage();
  await page.goto('https://chatgpt.com/?ui=2026&lang=xx');
  await page.addScriptTag({ path: join(root, 'content/selectors.js') });
  await page.addScriptTag({ path: join(root, 'content/driver.js') });
  const run = (opts) => page.evaluate((o) => globalThis.__CGA_DRIVER.run(o).catch((e) => ({ error: e.message })), { stableMs: 400, ...opts });
  const first = run({ prompt: 'unknown labels one' });
  // While ChatGPT is "thinking", the slot is a Stop button known only by its square icon.
  await page.waitForFunction(() => globalThis.__CGA_DRIVER.isGenerating());
  const diag = await page.evaluate(() => globalThis.__CGA_DRIVER.diagnose());
  assert.ok(diag.stop && diag.composer.found, `diagnostics: ${JSON.stringify(diag)}`);
  assert.equal((await first).text, 'Echo: unknown labels one');
  assert.equal((await run({ prompt: 'unknown labels two' })).text, 'Echo: unknown labels two');
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('sent'))), ['unknown labels one', 'unknown labels two']);
  assert.equal(await page.evaluate(() => localStorage.getItem('wrongClicks')), null);
  await browser.close();
  console.log('ok - driver, 2026 layout with unknown labels: Stop found by its icon, Send by its type');
}

async function launchExtension(query = '') {
  const userDataDir = mkdtempSync(join(tmpdir(), 'cga-e2e-'));
  const downloadsPath = mkdtempSync(join(tmpdir(), 'cga-dl-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    ...launchOpts,
    headless: true,
    channel: process.env.CHROMIUM_PATH ? undefined : 'chromium', // full Chromium: headless shell can't load extensions
    acceptDownloads: true,
    downloadsPath,
    viewport: { width: 420, height: 900 }, // roughly a side panel
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
  });
  await context.route(CHAT_ROUTE, mockRoute);
  await context.route(OTHER_ROUTE, otherRoute);

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;

  // Open the (mocked) ChatGPT tab up front, as a user would. Tabs the extension creates itself
  // bypass Playwright routing, so they would hit the real site.
  const chat = await context.newPage();
  await chat.goto(`https://chatgpt.com/${query}`);
  await chat.evaluate(() => localStorage.setItem('thinkMs', '1500'));
  await chat.goto('https://chatgpt.com/');

  const panel = await context.newPage();
  const consoleErrors = [];
  panel.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  panel.on('pageerror', (e) => consoleErrors.push(e.message));
  await panel.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);
  await panel.waitForSelector('#addPrompts:not(:empty)');
  return { context, chat, panel, consoleErrors, extensionId };
}

/** Wait until the runner is idle and the queue has the given status counts. */
const idle = (panel, want) => panel.waitForFunction(
  (w) => document.querySelector('#runnerStatus').textContent === 'Idle'
    && Object.entries(w).every(([status, n]) => document.querySelectorAll(`.qi.${status}`).length === n),
  want,
  { timeout: 120000 },
);

async function setSetting(panel, key, value) {
  const el = panel.locator(`[data-setting="${key}"]`);
  if (typeof value === 'boolean') await el.setChecked(value);
  else await el.fill(String(value));
  await el.dispatchEvent('change');
}

async function clearQueue(panel) {
  panel.once('dialog', (d) => d.accept());
  await panel.click('#clearBtn');
  await panel.waitForFunction(() => !document.querySelectorAll('.qi').length);
}

async function addPrompts(panel, text) {
  await panel.fill('#promptInput', text);
  await panel.click('#addPrompts');
}

const pageLoads = (chat) => chat.evaluate(() => JSON.parse(localStorage.getItem('pageLoads') || '0'));

/** Seconds the runner logged for "chat ready" on the given prompt number. */
async function chatReadySecs(panel, n) {
  const log = await panel.locator('#log').textContent();
  const m = new RegExp(`Prompt #${n}: chat ready in ([\\d.]+)s`).exec(log);
  assert.ok(m, `no timing logged for prompt #${n}`);
  return Number(m[1]);
}

/** Start the queue and check the first prompt reuses the page (no reload) and gets going quickly. */
async function startAndCheckFastFirstPrompt(panel, chat, label) {
  const loadsBefore = await pageLoads(chat);
  await panel.click('#startBtn');
  await panel.waitForFunction(() => document.querySelectorAll('.qi.completed, .qi.refused, .qi.failed').length >= 1, null, { timeout: 60000 });
  assert.equal(await pageLoads(chat), loadsBefore, `${label}: first prompt must not reload ChatGPT`);
  const secs = await chatReadySecs(panel, 1);
  assert.ok(secs < 5, `${label}: chat ready took ${secs}s`);
}

const sentPrompts = (chat) => chat.evaluate(() => JSON.parse(localStorage.getItem('sent') || '[]'));
const conversations = (chat) => chat.evaluate(() => JSON.parse(localStorage.getItem('conversations') || '[]'));
const queueState = (panel) => panel.evaluate(async () => (await chrome.storage.local.get('cga_queue')).cga_queue);
const sessionUrl = (panel) => panel.evaluate(async () => (await chrome.storage.local.get('cga_session')).cga_session?.chatUrl);

async function testExtension({ name, query }) {
  const { context, chat, panel, consoleErrors } = await launchExtension(query);
  const debugLog = async () => process.env.E2E_DEBUG && console.log(await panel.locator('#log li').allTextContents());

  // Language switching
  await panel.selectOption('#language', 'vi');
  await panel.waitForFunction(() => document.querySelector('#addPrompts').textContent === 'Thêm vào hàng đợi');
  await panel.selectOption('#language', 'en');
  await panel.waitForFunction(() => document.querySelector('#addPrompts').textContent === 'Add to queue');

  // Fast settings for the test
  await panel.click('#settingsCard summary');
  for (const [k, v] of [['minDelay', 0], ['maxDelay', 1], ['maxRetries', 1], ['project', 'e2e']]) await setSetting(panel, k, v);
  assert.equal(await panel.locator('[data-setting="singleChat"]').isChecked(), true, 'one chat is the default');
  assert.equal(await panel.locator('[data-setting="newChatPerPrompt"]').isDisabled(), true);

  // --- 1. Text queue: retry + failure + downloads ---------------------------------------------
  await addPrompts(panel, 'first prompt\nsecond prompt\nthis one will fail');
  assert.equal(await panel.locator('.qi').count(), 3);
  await startAndCheckFastFirstPrompt(panel, chat, 'blank tab');
  await idle(panel, { completed: 2, failed: 1 });
  await debugLog();
  assert.match(await panel.locator('.qi.failed .qi-retries').textContent(), /1\/1/);
  assert.equal(await panel.locator('.qi.completed .qi-retries').first().textContent(), '');
  // Playwright stores downloads under GUID names, so check the count and the requested paths in the log.
  assert.equal(await panel.evaluate(async () => (await chrome.downloads.search({})).length), 2);
  const log1 = await panel.locator('#log').textContent();
  assert.match(log1, /Saved ChatGPT-Automation\/e2e\/001-first-prompt\.md/);
  assert.match(log1, /Saved ChatGPT-Automation\/e2e\/002-second-prompt\.md/);
  assert.equal((await conversations(chat)).length, 1, 'text run stayed in one chat');
  console.log(`ok - extension, ${name}: text queue with retry + failure, downloads, one chat, fast first prompt`);

  // --- 2. Images in one chat, refused prompt retried once then skipped -----------------------
  await clearQueue(panel); // also forgets the session chat
  await panel.click('[data-mode="textToImage"]');
  await addPrompts(panel, 'image of a red square\nforbidden image of something\nimage of a blue square');
  await startAndCheckFastFirstPrompt(panel, chat, 'tab inside a conversation');
  await idle(panel, { completed: 2, refused: 1 });
  await debugLog();
  let q = await queueState(panel);
  assert.equal(q[1].status, 'refused');
  assert.equal(q[1].refusals, 2, 'refused prompt was retried once before skipping');
  assert.equal(q[2].status, 'completed', 'queue moved on after the refusal');
  const chat2 = await sessionUrl(panel);
  assert.ok(q.every((i) => i.chatUrl === chat2), `all prompts in the session chat: ${q.map((i) => i.chatUrl)}`);
  assert.equal((await conversations(chat)).length, 2, 'image run used exactly one new chat');
  assert.match(await panel.locator('#log').textContent(), /refused by ChatGPT — skipped/);
  assert.equal(await panel.locator('#sessionLink').isVisible(), true);
  console.log(`ok - extension, ${name}: image queue in one chat, refused prompt retried then skipped`);

  // --- 3. Interruption: ChatGPT tab navigated away mid-reply (first prompt of a new session) --
  await clearQueue(panel);
  await addPrompts(panel, 'slow image number one\nimage number two');
  await panel.click('#startBtn');
  await chat.waitForSelector(STOP_SELECTOR);
  await chat.waitForTimeout(1500);
  await chat.goto('https://chatgpt.com/'); // interrupt: user wanders off to a new chat
  await idle(panel, { completed: 2 });
  await debugLog();
  q = await queueState(panel);
  const chat3 = await sessionUrl(panel);
  assert.ok(q.every((i) => i.chatUrl === chat3), 'both prompts ended up in the session chat');
  assert.equal(new URL(chat.url()).pathname, new URL(chat3).pathname, 'tab was brought back to the session chat');
  const sent3 = await sentPrompts(chat);
  assert.equal(q[0].retries || 0, 0, 'an interruption does not use up normal retries');
  assert.equal(sent3.filter((p) => p.startsWith('slow image number one')).length, 1, 'interrupted prompt was not resent');
  const log3 = await panel.locator('#log').textContent();
  assert.match(log3, /Returning to the session chat/);
  assert.match(log3, /already sent before the interruption/);
  console.log(`ok - extension, ${name}: interruption -> back to the session chat, no resend`);

  // --- 4. Side panel closed/reopened mid-reply -------------------------------------------------
  await addPrompts(panel, 'slow image number three');
  await panel.click('#startBtn');
  await chat.waitForSelector(STOP_SELECTOR);
  await chat.waitForTimeout(1500);
  await panel.reload(); // panel closed mid-run
  await panel.waitForSelector('#addPrompts:not(:empty)');
  assert.equal(await panel.locator('.qi.queued').count(), 1);
  await panel.click('#startBtn');
  await idle(panel, { completed: 3 });
  await debugLog();
  q = await queueState(panel);
  assert.equal(q[2].chatUrl, chat3, 'resumed in the same session chat');
  assert.equal((await sentPrompts(chat)).filter((p) => p.startsWith('slow image number three')).length, 1, 'not resent');
  console.log(`ok - extension, ${name}: panel reopened mid-run -> resumed, no resend`);

  // --- 5. ChatGPT tab in the background: brought to the front before the prompt ----------------
  await clearQueue(panel);
  await panel.click('[data-mode="text"]');
  const other = await context.newPage();
  await other.goto('https://example.org/');
  await other.bringToFront();
  const chatActive = () => panel.evaluate(async () => (await chrome.tabs.query({ url: 'https://chatgpt.com/*' }))[0]?.active);
  assert.equal(await chatActive(), false, 'ChatGPT tab starts in the background');
  await addPrompts(panel, 'background one\nbackground two\nbackground three');
  await panel.click('#startBtn');
  await idle(panel, { completed: 3 });
  await debugLog();
  assert.equal(await chatActive(), true, 'ChatGPT tab was brought to the front');
  const log5 = await panel.locator('#log').textContent();
  assert.match(log5, /Brought the ChatGPT tab to the front/);
  assert.match(log5, /Prompt #3: sent, waiting for the reply/);
  q = await queueState(panel);
  assert.deepEqual(q.map((i) => i.output), ['Echo: background one', 'Echo: background two', 'Echo: background three']);
  const sent5 = (await sentPrompts(chat)).filter((p) => p.startsWith('background'));
  assert.deepEqual(sent5, ['background one', 'background two', 'background three'], `${name}: each sent once, in order`);
  assert.equal(await chat.evaluate(() => localStorage.getItem('wrongClicks')), null, 'never clicked Voice/Dictation');
  await other.close();
  console.log(`ok - extension, ${name}: background ChatGPT tab brought to the front, 3 prompts in order, none twice`);

  // Diagnostics: a copyable report of what the driver sees.
  await panel.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `chrome-extension://${new URL(panel.url()).host}` }).catch(() => {});
  await panel.click('details:has(#log) > summary');
  await panel.click('#copyDiagnosticsBtn');
  await panel.waitForFunction(() => /Diagnostics copied/.test(document.querySelector('#log').textContent));

  await panel.click('[data-mode="text"]');
  if (query.includes('legacy')) await panel.screenshot({ path: join(root, 'docs', 'screenshot-panel.png'), fullPage: true }).catch(() => {});
  assert.deepEqual(consoleErrors, []);
  await context.close();
}

for (const layout of LAYOUTS) await testDriver(layout);
await testDriverUnknownLabels();
for (const layout of LAYOUTS) await testExtension(layout);
