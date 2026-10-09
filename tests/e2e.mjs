// End-to-end tests with Playwright + Chromium. https://chatgpt.com is served by tests/fake-chatgpt.mjs
// (the backend) and tests/mock-chatgpt.html (the page), which send prompts and stream replies the
// way the real site does.
//  1. The content scripts on their own (net-hook + agent): text, several in a row, images (also one
//     drawn after the reply stream has closed), a reply handed off after the stream, attachments,
//     errors, rate limit, refusal, question -> one nudge, resume without resending, and the
//     page-watching fallback when the conversation can't be read.
//  2. The real unpacked extension driven from its side panel: the queue gets past the first prompt
//     in every mode, retries, downloads, concurrent tabs, Concat, interruption, Stop/Run, Fix Error,
//     model choice, languages, diagnostics.
// Run: npm run test:e2e   (needs the `playwright` package; set CHROMIUM_PATH to override the browser)
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { FakeChatGPT, NUDGE } from './fake-chatgpt.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OTHER_ROUTE = /^https:\/\/example\.org\/.*/;
const otherRoute = (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Other</title><p>Another site</p>' });
const debug = (...a) => process.env.E2E_DEBUG && console.log(...a);

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
const pngWidth = (dataUrl) => Buffer.from(dataUrl.split(',')[1], 'base64').readUInt32BE(16);

// ---- 1. Content scripts on their own ------------------------------------------------------------

async function testAgent() {
  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext();
  const fake = new FakeChatGPT();
  await fake.install(context);
  const page = await context.newPage();
  const inject = async () => {
    for (const f of ['content/sse.js', 'content/net-hook.js', 'content/selectors.js', 'content/conversation.js', 'content/agent.js']) {
      await page.addScriptTag({ path: join(root, f) });
    }
  };
  await page.goto('https://chatgpt.com/');
  await inject();

  /** Run one job to the end, the way the panel does: start it, then poll. */
  const run = (opts) => page.evaluate(async (o) => {
    const A = globalThis.__CGA_AGENT;
    const job = A.createJob({ id: crypto.randomUUID(), timeoutMs: 120000, ...o });
    A.startJob(job);
    for (;;) {
      await new Promise((r) => setTimeout(r, 400));
      await A.tick(job);
      const s = A.snapshot(job);
      if (['done', 'error', 'refused'].includes(s.state)) return { ...s, images: (s.images || []).map((i) => i.slice(0, 40000)) };
    }
  }, opts);

  const text = await run({ prompt: 'hello there\nsecond line' });
  assert.equal(text.state, 'done', JSON.stringify(text));
  assert.equal(text.text, 'Echo: hello there\nsecond line');
  assert.equal(text.mode, 'net');
  assert.match(page.url(), /\/c\/68e1aaaa-/);

  // Several prompts in a row: each reply is collected and the next prompt goes out (the reported bug).
  for (const n of [1, 2, 3]) {
    const r = await run({ prompt: `follow-up number ${n}` });
    assert.equal(r.text, `Echo: follow-up number ${n}`, `reply ${n}: ${JSON.stringify(r)}`);
  }

  const img = await run({ prompt: 'draw an image of a cat', expectImages: true });
  assert.equal(img.state, 'done', JSON.stringify(img));
  assert.equal(img.images.length, 1);
  assert.equal(pngWidth(img.images[0]), 256);

  // The stream closes while the image is still being drawn; it lands 5 s later.
  const t0 = Date.now();
  const late = await run({ prompt: 'an async image of a boat', expectImages: true });
  assert.equal(late.state, 'done', JSON.stringify(late));
  assert.equal(late.images.length, 1);
  assert.ok(Date.now() - t0 >= 5000, 'waited for the image after the stream closed');

  // The stream hands off at once; the reply appears in the conversation later.
  const handoff = await run({ prompt: 'handoff please' });
  assert.equal(handoff.text, 'Echo: handoff please', JSON.stringify(handoff));

  const dot = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const attachStart = Date.now();
  const withFile = await run({ prompt: 'describe', files: [{ name: 'alice.png', dataUrl: dot }] });
  assert.equal(withFile.text, 'Echo: describe [files: alice.png]');
  assert.ok(Date.now() - attachStart < 15000, `attaching took ${Date.now() - attachStart} ms (page spinner taken for an upload?)`);

  const failed = await run({ prompt: 'please fail' });
  assert.equal(failed.state, 'error');
  assert.equal(failed.stage, 'chatgpt');
  assert.match(failed.error, /something went wrong/i);

  const limited = await run({ prompt: 'rate limit me' });
  assert.equal(limited.state, 'error');
  assert.equal(limited.stage, 'chatgpt');
  assert.match(limited.error, /reached our limit/);

  const refused = await run({ prompt: 'a forbidden image', expectImages: true });
  assert.equal(refused.state, 'refused', JSON.stringify(refused));

  // ChatGPT asks a question instead of drawing: one follow-up in the same chat, then the image.
  const before = fake.sent.length;
  const asked = await run({ prompt: 'ask first: an image of a fox', expectImages: true });
  assert.equal(asked.state, 'done', JSON.stringify(asked));
  assert.equal(asked.images.length, 1);
  assert.equal(asked.nudged, true);
  assert.deepEqual(fake.sent.slice(before), ['ask first: an image of a fox', NUDGE]);

  // Resume: the prompt went out, then the page was reloaded -> follow its reply, don't resend.
  const sentBefore = fake.sent.length;
  await page.evaluate(() => {
    const A = globalThis.__CGA_AGENT;
    A.startJob(A.createJob({ id: 'x', prompt: 'slow resume test', timeoutMs: 120000 }));
  });
  await page.waitForFunction(() => location.pathname.startsWith('/c/') && document.querySelector('[data-testid="stop-button"]'));
  await page.reload();
  await inject();
  const resumed = await run({ prompt: 'slow resume test', resume: true });
  assert.equal(resumed.state, 'done', JSON.stringify(resumed));
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.text, 'Echo: slow resume test');
  assert.equal(fake.sent.length - sentBefore, 1, 'resume must not send again');
  const fresh = await run({ prompt: 'not sent yet', resume: true });
  assert.equal(fresh.resumed, false);
  assert.equal(fresh.text, 'Echo: not sent yet');

  // The conversation can't be read: watch the page instead.
  fake.jsonOff = true;
  const viaPage = await run({ prompt: 'page mode text' });
  assert.equal(viaPage.state, 'done', JSON.stringify(viaPage));
  assert.equal(viaPage.mode, 'page');
  fake.jsonOff = false;

  // Image download links fail: the picture is taken from the page.
  fake.imageLinksOff = true;
  const fromPage = await run({ prompt: 'image of a blue square', expectImages: true });
  assert.equal(fromPage.state, 'done', JSON.stringify(fromPage));
  assert.equal(fromPage.images.length, 1);
  fake.imageLinksOff = false;

  const sent = fake.prompts();
  assert.equal(new Set(sent).size, sent.length, `no prompt sent twice: ${sent}`);
  assert.deepEqual(await page.evaluate(() => [localStorage.getItem('wrongClicks'), localStorage.getItem('stoppedReplies')]), [null, null], 'never clicked Voice or Stop');
  await browser.close();
  console.log('ok - content scripts: text, 3 in a row, image, image after the stream, handoff, files, error, rate limit, refusal, question -> nudge, resume, page fallback, image from the page');
}

// ---- 2. The extension ----------------------------------------------------------------------------

async function launchExtension() {
  const userDataDir = mkdtempSync(join(tmpdir(), 'cga-e2e-'));
  const downloadsPath = mkdtempSync(join(tmpdir(), 'cga-dl-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    ...launchOpts,
    headless: true,
    channel: process.env.CHROMIUM_PATH ? undefined : 'chromium', // full Chromium: headless shell can't load extensions
    acceptDownloads: true,
    downloadsPath,
    viewport: { width: 420, height: 900 },
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
  });
  const fake = new FakeChatGPT();
  await fake.install(context);
  await context.route(OTHER_ROUTE, otherRoute);
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;

  // Open the ChatGPT tab up front, as a user would.
  const chat = await context.newPage();
  await chat.goto('https://chatgpt.com/');

  const panel = await context.newPage();
  const consoleErrors = [];
  panel.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  panel.on('pageerror', (e) => consoleErrors.push(e.message));
  await panel.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);
  await panel.waitForSelector('#runBtn:not(:empty)');
  return { context, chat, panel, fake, consoleErrors };
}

const idle = (panel, want, timeout = 240000) => panel.waitForFunction(
  (w) => document.querySelector('#runnerStatus').textContent === 'Idle'
    && Object.entries(w).every(([status, n]) => document.querySelectorAll(`.qi.${status}`).length === n),
  want,
  { timeout },
);

async function setSetting(panel, key, value) {
  const el = panel.locator(`[data-setting="${key}"]:visible`).first();
  if (typeof value === 'boolean') await el.setChecked(value);
  else if (await el.evaluate((e) => e.tagName === 'SELECT')) await el.selectOption(String(value));
  else await el.fill(String(value));
  await el.dispatchEvent('change');
}

async function clearQueue(panel) {
  if (!(await panel.locator('.qi').count())) return;
  await panel.click('#clearBtn');
  await panel.waitForFunction(() => document.querySelector('#clearBtn').classList.contains('danger'));
  await panel.click('#clearBtn');
  await panel.waitForFunction(() => !document.querySelectorAll('.qi').length);
}

async function run(panel, prompts, mode = 'text') {
  await panel.click(`#modeTabs [data-mode="${mode}"]`);
  await panel.fill('#promptInput', prompts.join('\n\n'));
  await panel.click('#runBtn');
}

const queueState = (panel) => panel.evaluate(async () => (await chrome.storage.local.get('cga_queue')).cga_queue);
const logText = (panel) => panel.locator('#log').textContent();
const downloads = (panel) => panel.evaluate(async () => (await chrome.downloads.search({})).length);

async function testExtension() {
  const { context, chat, panel, fake, consoleErrors } = await launchExtension();
  const dumpLog = async () => debug((await panel.locator('#log li').allTextContents()).reverse().join('\n'));

  // Languages
  await panel.click('#tabSetting');
  await panel.selectOption('#language', 'vi');
  await panel.waitForFunction(() => document.querySelector('#runBtn').textContent === 'Chạy');
  await panel.selectOption('#language', 'en');
  await panel.waitForFunction(() => document.querySelector('#runBtn').textContent === 'Run');
  for (const [k, v] of [['minDelay', 0], ['maxDelay', 1], ['maxRetries', 1]]) await setSetting(panel, k, v);
  await panel.click('#tabControl');
  await setSetting(panel, 'folder', 'e2e');

  // --- 1. Five text prompts: the queue gets past the first one and finishes all of them -------
  const five = ['first prompt', 'second prompt', 'third prompt', 'fourth prompt', 'fifth prompt'];
  await run(panel, five);
  await idle(panel, { completed: 5 });
  await dumpLog();
  let q = await queueState(panel);
  assert.deepEqual(q.map((i) => i.output), five.map((p) => `Echo: ${p}`));
  assert.deepEqual(fake.prompts(), five, 'each sent once, in order');
  assert.equal(await downloads(panel), 5);
  let log = await logText(panel);
  assert.match(log, /Saved e2e\/001-first-prompt\.md/);
  assert.match(log, /Saved e2e\/005-fifth-prompt\.md/);
  assert.match(log, /Prompt #5: completed in [\d.]+s \(network\)/);
  assert.equal(new Set(q.map((i) => i.chatUrl)).size, 5, 'New Chat for every prompt');
  console.log('ok - extension: 5 text prompts in a row, each in a new chat, downloads');

  // --- 2. Failure with retry, then the queue moves on ---------------------------------------------
  await clearQueue(panel);
  fake.sent.length = 0;
  await run(panel, ['please fail', 'after the failure']);
  await idle(panel, { completed: 1, failed: 1 });
  q = await queueState(panel);
  assert.equal(q[0].status, 'failed');
  assert.equal(q[0].retries, 2);
  assert.equal(q[1].output, 'Echo: after the failure');
  assert.match(await panel.locator('.qi.failed .qi-extra').textContent(), /retry 2\/1/);
  console.log('ok - extension: failure retried, then marked failed, queue moved on');

  // --- 3. Text to Image, including an image drawn after the stream closed and a refusal --------
  await clearQueue(panel);
  fake.sent.length = 0;
  const before = await downloads(panel);
  await run(panel, ['image of a red square', 'an async image of a boat', 'forbidden image of something', 'ask first: an image of a hat', 'image of a blue square'], 'textToImage');
  await idle(panel, { completed: 4, refused: 1 });
  await dumpLog();
  q = await queueState(panel);
  assert.deepEqual(q.map((i) => i.status), ['completed', 'completed', 'refused', 'completed', 'completed']);
  assert.ok(q.filter((i) => i.status === 'completed').every((i) => i.imageCount === 1));
  assert.equal(q[2].refusals, 2, 'refused prompt was retried once before skipping');
  assert.equal(await downloads(panel) - before, 4, 'four images saved');
  log = await logText(panel);
  assert.match(log, /Saved e2e\/002-an-async-image-of-a-boat\.png/);
  assert.match(log, /Prompt #4: ChatGPT answered without an image/);
  assert.match(log, /refused by ChatGPT — skipped/);
  assert.equal(fake.sent.filter((p) => p.startsWith('ask first')).length, 1, 'question prompt not resent');
  console.log('ok - extension: Text to Image, image after the stream, refusal skipped, question -> one nudge');

  // --- 4. Concat keeps the next prompt in the same chat; model choice is applied --------------
  await clearQueue(panel);
  await panel.click('#tabSetting');
  await setSetting(panel, 'defaultPromptMode', 'concat');
  await setSetting(panel, 'textModel', 'gpt-5');
  await panel.click('#tabControl');
  fake.models.length = 0;
  await run(panel, ['concat one', 'concat two', 'concat three']);
  await idle(panel, { completed: 3 });
  q = await queueState(panel);
  assert.equal(new Set(q.map((i) => i.chatUrl)).size, 1, `one chat for the Concat run: ${q.map((i) => i.chatUrl)}`);
  assert.deepEqual(fake.models, ['gpt-5', 'gpt-5', 'gpt-5'], 'model from ?model= used');
  await panel.click('#tabSetting');
  await setSetting(panel, 'defaultPromptMode', 'new');
  await setSetting(panel, 'textModel', '');
  await panel.click('#tabControl');
  console.log('ok - extension: Concat keeps one chat, Text Model applied');

  // --- 5. Interruption: the ChatGPT tab leaves mid-reply -> back to its chat, not resent --------
  await clearQueue(panel);
  fake.sent.length = 0;
  await run(panel, ['slow interrupted prompt', 'after the interruption']);
  await chat.waitForFunction(() => location.pathname.startsWith('/c/') && document.querySelector('[data-testid="stop-button"]'));
  await chat.waitForTimeout(1000);
  await chat.goto('https://example.org/');
  await idle(panel, { completed: 2 });
  await dumpLog();
  q = await queueState(panel);
  assert.equal(q[0].output, 'Echo: slow interrupted prompt');
  assert.equal(q[0].retries || 0, 0, 'an interruption does not use up retries');
  assert.deepEqual(fake.sent, ['slow interrupted prompt', 'after the interruption'], 'interrupted prompt not resent');
  log = await logText(panel);
  assert.match(log, /Returning to the prompt's chat/);
  assert.match(log, /already sent before the interruption/);
  console.log('ok - extension: interruption -> back to the chat, reply collected, no resend');

  // --- 6. Stop mid-reply, then Run: picks up the same reply ------------------------------------
  await clearQueue(panel);
  fake.sent.length = 0;
  await run(panel, ['slow stopped prompt']);
  await chat.waitForFunction(() => location.pathname.startsWith('/c/') && document.querySelector('[data-testid="stop-button"]'));
  await panel.click('#stopBtn');
  await idle(panel, { queued: 1 });
  await panel.click('#runBtn');
  await idle(panel, { completed: 1 });
  q = await queueState(panel);
  assert.equal(q[0].output, 'Echo: slow stopped prompt');
  assert.deepEqual(fake.sent, ['slow stopped prompt'], 'Run after Stop collects the reply, no resend');
  console.log('ok - extension: Stop then Run collects the same reply');

  // --- 6b. The panel closes mid-reply; reopened, Run collects that reply -----------------------
  await clearQueue(panel);
  fake.sent.length = 0;
  await run(panel, ['slow panel reload prompt']);
  await panel.waitForFunction(async () => (await chrome.storage.local.get('cga_queue')).cga_queue?.[0]?.chatUrl);
  await panel.reload();
  await panel.waitForSelector('#runBtn:not(:empty)');
  assert.equal(await panel.locator('.qi.queued').count(), 1);
  await panel.click('#runBtn');
  await idle(panel, { completed: 1 });
  assert.equal((await queueState(panel))[0].output, 'Echo: slow panel reload prompt');
  assert.deepEqual(fake.sent, ['slow panel reload prompt'], 'not resent after the panel reopened');
  console.log('ok - extension: panel reopened mid-reply -> reply collected, no resend');

  // --- 7. Fix Error on a running prompt: it runs again and completes -----------------------------
  await clearQueue(panel);
  await run(panel, ['slow fixed prompt', 'after fix']);
  await chat.waitForFunction(() => document.querySelector('[data-testid="stop-button"]'));
  await panel.click('#fixBtn');
  await idle(panel, { completed: 2 });
  assert.match(await logText(panel), /Prompt #1 will run again/);
  console.log('ok - extension: Fix Error re-runs the stuck prompt');

  // --- 8. Two concurrent prompts in two tabs, with the ChatGPT tabs in the background -----------
  await clearQueue(panel);
  fake.sent.length = 0;
  const chat2 = await context.newPage();
  await chat2.goto('https://chatgpt.com/');
  const other = await context.newPage();
  await other.goto('https://example.org/');
  await other.bringToFront();
  await panel.click('#tabSetting');
  await setSetting(panel, 'concurrency', 2);
  await setSetting(panel, 'keepTabActive', false);
  await panel.click('#tabControl');
  const t0 = Date.now();
  await run(panel, ['parallel a', 'parallel b', 'parallel c', 'parallel d']);
  await panel.waitForFunction(() => /Running \(2\)/.test(document.querySelector('#runnerStatus').textContent), null, { timeout: 30000 });
  await idle(panel, { completed: 4 });
  q = await queueState(panel);
  assert.deepEqual(q.map((i) => i.output), ['a', 'b', 'c', 'd'].map((x) => `Echo: parallel ${x}`));
  assert.deepEqual([...fake.sent].sort(), ['parallel a', 'parallel b', 'parallel c', 'parallel d']);
  debug(`concurrent run took ${Date.now() - t0} ms`);
  await panel.click('#tabSetting');
  await setSetting(panel, 'concurrency', 1);
  await panel.click('#tabControl');
  await other.close();
  await chat2.close();
  console.log('ok - extension: 2 concurrent prompts in two tabs');

  // Diagnostics
  await panel.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(panel.url()).origin }).catch(() => {});
  await panel.click('#logCard > summary');
  await panel.click('#copyDiagnosticsBtn');
  await panel.waitForFunction(() => /Diagnostics copied/.test(document.querySelector('#log').textContent));

  await panel.click('#modeTabs [data-mode="text"]');
  await panel.evaluate(() => { document.querySelector('#logCard').open = false; });
  await panel.screenshot({ path: join(root, 'docs', 'screenshot-panel.png'), fullPage: true }).catch(() => {});
  assert.deepEqual(consoleErrors, []);
  await context.close();
}

await testAgent();
await testExtension();
console.log('all e2e tests passed');
