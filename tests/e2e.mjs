// End-to-end test with Playwright + Chromium, with https://chatgpt.com routed to tests/mock-chatgpt.html:
//  1. content/driver.js on its own: text, image, attachment, error, policy refusal, resume without resend
//  2. the real unpacked extension driven from its side panel:
//     - text queue with retry + failure, downloads, language switching
//     - image queue kept in ONE chat, with a refused prompt retried then skipped
//     - interruption (ChatGPT tab navigated away mid-reply) -> returns to the session chat, no resend
//     - side panel reopened mid-reply -> resumes in the same chat, no resend
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

async function testDriver() {
  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext();
  await context.route(CHAT_ROUTE, mockRoute);
  const page = await context.newPage();
  const inject = async () => {
    await page.addScriptTag({ path: join(root, 'content/selectors.js') });
    await page.addScriptTag({ path: join(root, 'content/driver.js') });
  };
  await page.goto('https://chatgpt.com/');
  await inject();

  const run = (opts) => page.evaluate((o) => globalThis.__CGA_DRIVER.run(o).catch((e) => ({ error: e.message })), { stableMs: 400, ...opts });

  const text = await run({ prompt: 'hello there\nsecond line' });
  assert.match(text.text, /^Echo: hello there/);
  assert.deepEqual(text.images, []);
  assert.match(text.url, /\/c\/mock-/);

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
  await page.waitForSelector('[data-message-author-role="assistant"]');
  const sentBefore = await page.evaluate(() => JSON.parse(localStorage.getItem('sent')).length);
  const resumed = await run({ prompt: 'a forbidden image', expectImages: true, resumeIfSent: true });
  assert.equal(resumed.refused, true);
  const again = await run({ prompt: 'a forbidden image', expectImages: true, resumeIfSent: false });
  assert.equal(again.refused, true);
  const sentAfter = await page.evaluate(() => JSON.parse(localStorage.getItem('sent')).length);
  assert.equal(sentAfter - sentBefore, 1, 'resumeIfSent must not resend; a normal run must');

  await browser.close();
  console.log('ok - driver against mock page (incl. refusal + resume)');
}

async function launchExtension() {
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

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;

  // Open the (mocked) ChatGPT tab up front, as a user would. Tabs the extension creates itself
  // bypass Playwright routing, so they would hit the real site.
  const chat = await context.newPage();
  await chat.goto('https://chatgpt.com/');

  const panel = await context.newPage();
  const consoleErrors = [];
  panel.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  panel.on('pageerror', (e) => consoleErrors.push(e.message));
  await panel.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);
  await panel.waitForSelector('#addPrompts:not(:empty)');
  return { context, chat, panel, consoleErrors };
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

async function testExtension() {
  const { context, chat, panel, consoleErrors } = await launchExtension();
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
  console.log('ok - text queue with retry + failure, downloads, one chat, fast first prompt (no reload)');

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
  console.log('ok - image queue in one chat via in-page New chat, refused prompt retried then skipped');

  // --- 3. Interruption: ChatGPT tab navigated away mid-reply (first prompt of a new session) --
  await clearQueue(panel);
  await addPrompts(panel, 'slow image number one\nimage number two');
  await panel.click('#startBtn');
  await chat.waitForSelector('[data-testid="stop-button"]');
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
  console.log('ok - interruption: returned to the session chat and continued without resending');

  // --- 4. Side panel closed/reopened mid-reply -------------------------------------------------
  await addPrompts(panel, 'slow image number three');
  await panel.click('#startBtn');
  await chat.waitForSelector('[data-testid="stop-button"]');
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
  console.log('ok - panel reopened mid-run: resumed in the same chat without resending');

  await panel.click('[data-mode="text"]');
  await panel.screenshot({ path: join(root, 'docs', 'screenshot-panel.png'), fullPage: true }).catch(() => {});
  assert.deepEqual(consoleErrors, []);
  await context.close();
}

await testDriver();
await testExtension();
