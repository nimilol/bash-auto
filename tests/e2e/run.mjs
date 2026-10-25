// End-to-end tests: the real unpacked extension (as loaded in developer mode) in Chromium, driven
// from its panel, against the fake chatgpt.com in tests/fake. Covers the three requirements:
//   1. every prompt of a run lands in one chat
//   2. images are only failed when none is coming (slow, silent, preview, two-image replies)
//   3. a dropped connection pauses the run and it continues by itself, resending nothing
// Run: npm run test:e2e        Only some scenarios: E2E_ONLY=network,reload npm run test:e2e
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { FakeChatGPT, NUDGE } from '../fake/server.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ONLY = (process.env.E2E_ONLY || '').split(',').filter(Boolean);
const DEBUG = !!process.env.E2E_DEBUG;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    const globalRoot = execSync('npm root -g').toString().trim();
    return import(pathToFileURL(join(globalRoot, 'playwright', 'index.mjs')).href);
  }
}
const { chromium } = await loadPlaywright();

// ---- Harness -----------------------------------------------------------------------------------
const userDataDir = mkdtempSync(join(tmpdir(), 'bash-auto-e2e-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: true,
  channel: process.env.CHROMIUM_PATH ? undefined : 'chromium', // full Chromium: the headless shell can't load extensions
  executablePath: process.env.CHROMIUM_PATH || undefined,
  acceptDownloads: true,
  viewport: { width: 440, height: 900 },
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
});
const fake = new FakeChatGPT();
await fake.install(context);
await context.route(/^https:\/\/example\.org\/.*/, (r) => r.fulfill({ contentType: 'text/html', body: '<title>Other</title>' }));

let [worker] = context.serviceWorkers();
if (!worker) worker = await context.waitForEvent('serviceworker');
const extId = new URL(worker.url()).host;
const errors = [];
const watchErrors = (page, name) => {
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/net::ERR_INTERNET_DISCONNECTED|Failed to load resource|ERR_FAILED/.test(m.text())) errors.push(`${name}: ${m.text()}`); });
};

const chat = await context.newPage();
watchErrors(chat, 'chat');
await chat.goto('https://chatgpt.com/');
let panel = await openPanel();

async function openPanel() {
  const p = await context.newPage();
  watchErrors(p, 'panel');
  await p.goto(`chrome-extension://${extId}/panel/index.html`);
  await p.waitForSelector('#runBtn');
  return p;
}

const storage = (keys) => panel.evaluate((k) => chrome.storage.local.get(k), keys);
const queue = async () => (await storage(['queue'])).queue || [];
const runState = async () => (await storage(['run'])).run || {};

async function settings(patch) {
  await panel.evaluate(async (p) => {
    const cur = (await chrome.storage.local.get('settings')).settings || {};
    await chrome.storage.local.set({ settings: { ...cur, ...p } });
  }, patch);
}

async function addAndRun(prompts, mode = 'textToImage') {
  await panel.click(`#modes [data-mode="${mode}"]`);
  await panel.fill('#prompts', prompts.join('\n\n'));
  await panel.click('#runBtn');
}

async function waitFor(fn, what, timeout = 240000, every = 500) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(every);
  }
  await dumpLog();
  throw new Error(`Timed out waiting for ${what}`);
}

async function idle(timeout = 300000) {
  await sleep(300);
  await waitFor(async () => (await runState()).state === 'idle', 'the run to finish', timeout);
  return queue();
}

async function dumpLog(n = 60) {
  const log = (await storage(['log'])).log || [];
  console.log(log.slice(-n).map((e) => `  ${new Date(e.t).toISOString().slice(11, 19)} ${e.kind.padEnd(7)} ${e.text}`).join('\n'));
}

async function clearQueue() {
  await panel.evaluate(() => chrome.runtime.sendMessage({ cmd: 'clearQueue' }));
  fake.sent.length = 0;
}

async function downloads() {
  return panel.evaluate(() => new Promise((resolve) => chrome.downloads.search({}, resolve)));
}

const sentCount = (re) => fake.sent.filter((s) => re.test(s.text)).length;
const convOf = (re) => [...new Set(fake.sent.filter((s) => re.test(s.text)).map((s) => s.convId))];

const results = [];
async function scenario(name, fn) {
  if (ONLY.length && !ONLY.includes(name)) return;
  const t0 = Date.now();
  try {
    await fn();
    results.push([name, 'ok', Date.now() - t0]);
    console.log(`ok - ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    results.push([name, 'FAIL', Date.now() - t0]);
    console.log(`not ok - ${name}: ${e.stack || e}`);
    await dumpLog(80).catch(() => {});
    process.exitCode = 1;
  } finally {
    if (DEBUG) await dumpLog(40).catch(() => {});
  }
}

await settings({ minDelay: 0, maxDelay: 0, noImageQuietMin: 0.25, imageWaitMin: 3, maxRetries: 2, folder: 'e2e', keepTabActive: true });

// ---- 1. One chat, every kind of image reply -----------------------------------------------------
let runConv = '';
await scenario('images', async () => {
  const prompts = [
    'image of a red fox',
    'image of a boat [async:20]',
    'image of a hat [silent:12]',
    'image of two cats [two]',
    'image of a tree [partial:8]',
    'image of a dog [ask]',
    'image of a lamp [dark:8]',
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `image of item number ${n}`),
  ];
  const before = (await downloads()).length;
  await addAndRun(prompts);
  const q = await idle();
  assert.deepEqual(q.map((i) => i.status), prompts.map(() => 'completed'), q.map((i) => `${i.prompt}: ${i.status} ${i.error}`).join('\n'));
  const convs = new Set(fake.sent.map((s) => s.convId));
  assert.equal(convs.size, 1, `one chat for all ${prompts.length} prompts`);
  assert.equal(new Set(q.map((i) => i.convId)).size, 1);
  runConv = [...convs][0];
  assert.equal((await runState()).convId, runConv);
  for (const p of prompts) assert.equal(sentCount(new RegExp(`^${p.replace(/[[\]]/g, '\\$&')}$`)), 1, `"${p}" sent once`);
  assert.equal(fake.sent.filter((s) => s.text === NUDGE).length, 1, 'one nudge for the question');
  assert.equal(q[3].imageCount, 2, 'both images of a two-image reply');
  assert.ok(q.every((i) => (i.retries || 0) === 0), 'no retries');
  assert.ok(q.every((i) => i.thumbs?.length), 'thumbnails');
  const files = (await downloads()).slice(before);
  await waitFor(async () => (await downloads()).slice(before).every((d) => d.state === 'complete'), 'downloads to complete', 30000);
  assert.equal(files.length, prompts.length + 1);
  // Playwright stores downloads under random names; the extension's names are in the log.
  const saved = (await storage(['log'])).log.map((e) => e.text).filter((t) => t.startsWith('Saved '));
  for (const name of ['e2e/001-image-of-a-red-fox.png', 'e2e/004-image-of-two-cats-two.png', 'e2e/004-image-of-two-cats-two-2.png', 'e2e/015-image-of-item-number-8.png']) {
    assert.ok(saved.includes(`Saved ${name}`), `${name} in ${saved.join(', ')}`);
  }
  // The blurred 64 px preview was not saved as the result: every file is a full 256 px image.
  const sizes = (await downloads()).slice(before).map((d) => d.fileSize || d.totalBytes);
  assert.ok(sizes.every((n) => n > 600), `all full-size images: ${sizes}`);
});

// ---- 2. Network drop in the middle of an image ---------------------------------------------------
await scenario('network', async () => {
  await clearQueue();
  await addAndRun(['image of a castle [async:25]', 'image of a bridge']);
  await waitFor(async () => (await queue())[0]?.phase === 'image', 'the castle to be generating', 60000);
  await context.setOffline(true);
  await waitFor(async () => (await runState()).state === 'waitingNetwork', '"waiting for network"', 60000);
  assert.match(await panel.locator('#statePill').textContent(), /Waiting for network/);
  await sleep(15000);
  assert.equal((await runState()).state, 'waitingNetwork', 'still waiting while offline');
  await context.setOffline(false);
  const q = await idle();
  assert.deepEqual(q.map((i) => i.status), ['completed', 'completed'], q.map((i) => i.error).join(' | '));
  assert.equal(q[0].retries || 0, 0, 'no retry used');
  assert.equal(sentCount(/castle/), 1, 'castle not resent');
  if (runConv) assert.deepEqual(convOf(/castle|bridge/), [runConv], 'still the run\'s chat');
  const log = (await storage(['log'])).log.map((e) => e.text).join('\n');
  assert.match(log, /Connection is back/);
});

// ---- 2b. The internet goes down while the browser still says it's online ----------------------
await scenario('network-silent', async () => {
  await clearQueue();
  await addAndRun(['image of a tower [async:20]', 'image of a road']);
  await waitFor(async () => (await queue())[0]?.phase === 'image', 'the tower to be generating', 60000);
  fake.down = true;
  await waitFor(async () => (await runState()).state === 'waitingNetwork', '"waiting for network"', 90000);
  await sleep(10000);
  fake.down = false;
  const q = await idle();
  assert.deepEqual(q.map((i) => i.status), ['completed', 'completed'], q.map((i) => i.error).join(' | '));
  assert.equal(q[0].retries || 0, 0);
  assert.equal(sentCount(/tower/), 1, 'tower not resent');
  if (runConv) assert.deepEqual(convOf(/tower|road/), [runConv]);
});

// ---- 3. Offline before the run starts --------------------------------------------------------
await scenario('offline-start', async () => {
  await clearQueue();
  await context.setOffline(true);
  await addAndRun(['image of a kite']);
  await waitFor(async () => (await runState()).state === 'waitingNetwork', '"waiting for network"', 90000);
  await sleep(8000);
  await context.setOffline(false);
  const q = await idle();
  assert.equal(q[0].status, 'completed', q[0].error);
  assert.equal(q[0].retries || 0, 0);
  assert.equal(sentCount(/kite/), 1);
});

// ---- 4. The ChatGPT tab is reloaded while the image is being made ------------------------------
await scenario('reload', async () => {
  await clearQueue();
  await addAndRun(['image of a ship [async:15]', 'image of a harbour']);
  await waitFor(async () => (await queue())[0]?.phase === 'image', 'the ship to be generating', 60000);
  await chat.reload();
  const q = await idle();
  assert.deepEqual(q.map((i) => i.status), ['completed', 'completed']);
  assert.equal(sentCount(/ship/), 1, 'not resent after the reload');
  assert.equal((q[0].retries || 0), 0);
  if (runConv) assert.deepEqual(convOf(/ship|harbour/), [runConv]);
});

// ---- 5. The panel is closed mid-run: the run goes on --------------------------------------------
await scenario('panel-closed', async () => {
  await clearQueue();
  await addAndRun(['image of a moon [async:6]', 'image of a sun', 'image of a star']);
  await waitFor(async () => fake.sent.length >= 1, 'the first prompt', 60000);
  await panel.close();
  const t0 = Date.now();
  while (Date.now() - t0 < 120000 && fake.sent.filter((s) => /moon|sun|star/.test(s.text)).length < 3) await sleep(500);
  assert.equal(fake.sent.filter((s) => /moon|sun|star/.test(s.text)).length, 3, 'all three sent while the panel was closed');
  panel = await openPanel();
  const q = await idle();
  assert.deepEqual(q.map((i) => i.status), ['completed', 'completed', 'completed']);
});

// ---- 6. Refusal, ChatGPT error with retries, then the queue goes on in the same chat -------------
await scenario('errors', async () => {
  await clearQueue();
  await settings({ maxRetries: 1 });
  await addAndRun(['image of a thing [refuse]', 'image of a mess [fail]', 'image of a cup']);
  const q = await idle();
  await settings({ maxRetries: 2 });
  assert.deepEqual(q.map((i) => i.status), ['refused', 'failed', 'completed'], q.map((i) => i.error).join(' | '));
  assert.equal(sentCount(/thing/), 2, 'refused prompt tried once more');
  assert.equal(sentCount(/mess/), 2, 'failed prompt: 1 try + 1 retry');
  assert.equal(new Set(fake.sent.map((s) => s.convId)).size, 1, 'retries stayed in the same chat');
});

// ---- 6b. The image task dies (stuck "in progress", error on the page): resent in the same chat --
await scenario('stuck', async () => {
  await clearQueue();
  await addAndRun(['image of a clock [stuck]', 'image of a vase']);
  const q = await idle();
  assert.deepEqual(q.map((i) => i.status), ['completed', 'completed'], q.map((i) => i.error).join(' | '));
  assert.equal(q[0].retries, 1);
  assert.equal(sentCount(/clock/), 2, 'sent again once');
  assert.equal(new Set(fake.sent.map((s) => s.convId)).size, 1, 'same chat');
  const log = (await storage(['log'])).log.map((e) => e.text).join('\n');
  assert.match(log, /went wrong/);
});

// ---- 7. Stop while generating, then Run: collected, not resent ----------------------------------
await scenario('stop-run', async () => {
  await clearQueue();
  await addAndRun(['image of a whale [async:12]']);
  await waitFor(async () => (await queue())[0]?.phase === 'image', 'the whale to be generating', 60000);
  await panel.click('#stopBtn');
  let q = await idle();
  assert.equal(q[0].status, 'queued');
  await panel.click('#runBtn');
  q = await idle();
  assert.equal(q[0].status, 'completed', q[0].error);
  assert.equal(sentCount(/whale/), 1);
});

// ---- 8. Image to Image with an uploaded source image ---------------------------------------------
await scenario('image-to-image', async () => {
  await clearQueue();
  await panel.click('#modes [data-mode="imageToImage"]');
  await panel.setInputFiles('#assetInput', { name: 'hero.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64') });
  await waitFor(async () => (await storage(['assets'])).assets?.sourceImages?.length === 1, 'the upload', 10000);
  await addAndRun(['image of the hero in the snow'], 'imageToImage');
  const q = await idle();
  assert.equal(q[0].status, 'completed', q[0].error);
  assert.deepEqual(fake.sent.at(-1).files, ['hero.png']);
  await panel.click('#clearAssets');
});

// ---- 9. Text prompts ---------------------------------------------------------------------------
await scenario('text', async () => {
  await clearQueue();
  await settings({ chatPolicy: 'same' });
  const before = (await downloads()).length;
  await addAndRun(['hello one', 'hello two [slowtext:5]', 'hello three'], 'text');
  const q = await idle();
  assert.deepEqual(q.map((i) => i.output), ['Echo: hello one', 'Echo: hello two [slowtext:5]', 'Echo: hello three']);
  assert.equal((await downloads()).length - before, 3);
  const saved = (await storage(['log'])).log.map((e) => e.text);
  for (const name of ['e2e/001-hello-one.md', 'e2e/002-hello-two-slowtext-5.md', 'e2e/003-hello-three.md']) assert.ok(saved.includes(`Saved ${name}`), name);
});

// ---- 10. Chat too long: pauses, "Continue in a new chat" goes on in a new chat ----------------
await scenario('too-long', async () => {
  await clearQueue();
  await panel.click('#modes [data-mode="textToImage"]');
  await addAndRun(['image of an owl [toolong]', 'image of a fern']);
  await waitFor(async () => (await runState()).state === 'paused', 'the pause', 60000);
  await panel.waitForSelector('#bannerAction:not([hidden])');
  const oldConv = (await runState()).convId;
  await panel.click('#bannerAction');
  const q = await idle();
  assert.deepEqual(q.map((i) => i.status), ['completed', 'completed']);
  const newConv = (await runState()).convId;
  assert.notEqual(newConv, oldConv);
  assert.deepEqual(convOf(/fern/), [newConv]);
});

// ---- 11. Each prompt in its own chat when chosen ------------------------------------------------
await scenario('per-prompt', async () => {
  await clearQueue();
  await settings({ chatPolicy: 'perPrompt' });
  await addAndRun(['image of a rose', 'image of a tulip']);
  const q = await idle();
  await settings({ chatPolicy: 'same' });
  assert.deepEqual(q.map((i) => i.status), ['completed', 'completed']);
  assert.equal(new Set(fake.sent.map((s) => s.convId)).size, 2);
});

// ---- 12. ChatGPT's conversation data can't be read: the page alone decides ---------------------
await scenario('page-only', async () => {
  await clearQueue();
  fake.jsonOff = true;
  try {
    await addAndRun(['image of a pear', 'image of two plums [two]']);
    if (DEBUG) {
      await sleep(9000);
      console.log(JSON.stringify(await panel.evaluate(() => chrome.runtime.sendMessage({ cmd: 'diagnostics' })), null, 1));
      console.log(await chat.evaluate(() => document.querySelector('main').innerHTML.slice(0, 1500)));
    }
    const q = await idle();
    assert.deepEqual(q.map((i) => i.status), ['completed', 'completed'], q.map((i) => i.error).join(' | '));
    assert.deepEqual(q.map((i) => i.imageCount), [1, 2]);
    assert.equal(sentCount(/pear|plum/), 2);
  } finally {
    fake.jsonOff = false;
  }
});

// ---- 13. (E2E_LONG=1) 20 prompts x 2 images each, all in one chat ------------------------------
if (process.env.E2E_LONG) {
  await scenario('long', async () => {
    await clearQueue();
    await settings({ imageOutputs: 2 });
    const prompts = Array.from({ length: 20 }, (_, n) => `image of scene ${n + 1}${n % 5 === 2 ? ' [async:6]' : ''}`);
    await addAndRun(prompts);
    const q = await idle(1800000);
    await settings({ imageOutputs: 1 });
    assert.equal(q.length, 40);
    assert.ok(q.every((i) => i.status === 'completed' && i.imageCount === 1), q.filter((i) => i.status !== 'completed').map((i) => `${i.prompt}: ${i.error}`).join('\n'));
    assert.equal(new Set(fake.sent.map((s) => s.convId)).size, 1, 'one chat');
    assert.equal(fake.sent.length, 40, 'each copy sent exactly once');
  });
}

// ---- Wrap up ---------------------------------------------------------------------------------
if (!ONLY.length || ONLY.includes('screenshot')) {
  await panel.bringToFront();
  await panel.screenshot({ path: join(root, 'docs', 'panel.png'), fullPage: true }).catch(() => {});
}
const neverClicked = await chat.evaluate(() => [localStorage.getItem('wrongClicks'), localStorage.getItem('stoppedReplies')]).catch(() => [null, null]);
try {
  assert.deepEqual(neverClicked, [null, null], 'never clicked Voice or Stop');
  assert.deepEqual(errors, [], 'no errors in the panel or the ChatGPT page');
} catch (e) {
  console.log(`not ok - page checks: ${e.message}`);
  process.exitCode = 1;
}
await context.close();
rmSync(userDataDir, { recursive: true, force: true });
const failed = results.filter((r) => r[1] !== 'ok');
console.log(failed.length || process.exitCode ? `FAILED: ${failed.map((r) => r[0]).join(', ') || 'page checks'}` : `all ${results.length} e2e scenarios passed`);
