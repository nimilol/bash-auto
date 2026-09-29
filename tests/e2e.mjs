// End-to-end test with Playwright + Chromium:
//  1. content/driver.js against tests/mock-chatgpt.html (text, image, attachment, error)
//  2. the real unpacked extension, with https://chatgpt.com routed to the mock page:
//     queue prompts in the side panel, run them, and check statuses + downloads.
// Run: npm run test:e2e   (needs the `playwright` package; set CHROMIUM_PATH to override the browser)
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mockHtml = readFileSync(join(root, 'tests/mock-chatgpt.html'), 'utf8');

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
  const page = await browser.newPage();
  await page.goto(pathToFileURL(join(root, 'tests/mock-chatgpt.html')).href);
  await page.addScriptTag({ path: join(root, 'content/selectors.js') });
  await page.addScriptTag({ path: join(root, 'content/driver.js') });

  const run = (opts) => page.evaluate((o) => globalThis.__CGA_DRIVER.run(o).catch((e) => ({ error: e.message })), { stableMs: 400, ...opts });

  const text = await run({ prompt: 'hello there\nsecond line' });
  assert.match(text.text, /^Echo: hello there/);
  assert.deepEqual(text.images, []);

  const img = await run({ prompt: 'draw an image of a cat', expectImages: true });
  assert.equal(img.images.length, 1);
  assert.match(img.images[0], /^data:image\/png;base64,/);

  const dot = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const withFile = await run({ prompt: 'describe', files: [{ name: 'alice.png', dataUrl: dot }] });
  assert.match(withFile.text, /\[files: alice\.png\]/);

  const failed = await run({ prompt: 'please fail' });
  assert.match(failed.error, /something went wrong/i);

  await browser.close();
  console.log('ok - driver against mock page');
}

async function testExtension() {
  const userDataDir = mkdtempSync(join(tmpdir(), 'cga-e2e-'));
  const downloadsPath = mkdtempSync(join(tmpdir(), 'cga-dl-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    ...launchOpts,
    headless: true,
    channel: process.env.CHROMIUM_PATH ? undefined : 'chromium', // full Chromium: headless shell can't load extensions
    acceptDownloads: true,
    viewport: { width: 420, height: 900 }, // roughly a side panel
    downloadsPath,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
  });
  await context.route(/^https:\/\/(chatgpt\.com|chat\.openai\.com)\/.*/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: mockHtml }));

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

  // Language switching
  await panel.selectOption('#language', 'vi');
  await panel.waitForFunction(() => document.querySelector('#addPrompts').textContent === 'Thêm vào hàng đợi');
  await panel.selectOption('#language', 'en');
  await panel.waitForFunction(() => document.querySelector('#addPrompts').textContent === 'Add to queue');

  // Fast settings for the test
  await panel.click('#settingsCard summary');
  for (const [k, v] of [['minDelay', '0'], ['maxDelay', '1'], ['maxRetries', '1'], ['project', 'e2e']]) {
    await panel.fill(`[data-setting="${k}"]`, v);
    await panel.dispatchEvent(`[data-setting="${k}"]`, 'change');
  }

  await panel.fill('#promptInput', 'first prompt\nsecond prompt\nthis one will fail');
  await panel.click('#addPrompts');
  assert.equal(await panel.locator('.qi').count(), 3);

  await panel.click('#startBtn');
  await panel.waitForFunction(
    () => document.querySelectorAll('.qi.completed').length === 2 && document.querySelectorAll('.qi.failed').length === 1
      && document.querySelector('#runnerStatus').textContent === 'Idle',
    null,
    { timeout: 90000 },
  );
  assert.match(await panel.locator('.qi.failed .qi-retries').textContent(), /1\/1/);
  assert.equal(await panel.locator('.qi.completed .qi-retries').first().textContent(), '', 'first prompt should not need a retry');

  // Playwright stores downloads under GUID names, so check the count here and the
  // requested paths in the activity log.
  const downloads = await panel.evaluate(async () => (await chrome.downloads.search({})).length);
  assert.equal(downloads, 2);
  const log = await panel.locator('#log').textContent();
  if (process.env.E2E_DEBUG) console.log(await panel.locator('#log li').allTextContents());
  assert.match(log, /Saved ChatGPT-Automation\/e2e\/001-first-prompt\.md/);
  assert.match(log, /Saved ChatGPT-Automation\/e2e\/002-second-prompt\.md/);

  // Text -> Image mode: one prompt, image is downloaded as PNG.
  panel.once('dialog', (d) => d.accept());
  await panel.click('#clearBtn');
  await panel.waitForFunction(() => !document.querySelectorAll('.qi').length);
  await panel.click('[data-mode="textToImage"]');
  await panel.fill('#promptInput', 'an image of a green square');
  await panel.click('#addPrompts');
  await panel.click('#startBtn');
  await panel.waitForFunction(
    () => document.querySelectorAll('.qi.completed').length === 1 && document.querySelector('#runnerStatus').textContent === 'Idle',
    null,
    { timeout: 90000 },
  );
  assert.match(await panel.locator('.qi-extra').textContent(), /1 image/);
  assert.match(await panel.locator('#log').textContent(), /Saved ChatGPT-Automation\/e2e\/001-an-image-of-a-green-square\.png/);
  await panel.click('[data-mode="text"]');

  await panel.screenshot({ path: join(root, 'docs', 'screenshot-panel.png'), fullPage: true }).catch(() => {});
  assert.deepEqual(consoleErrors, []);
  await context.close();
  console.log('ok - extension side panel run (text queue with retry + failure, image mode, downloads)');
}

await testDriver();
await testExtension();
