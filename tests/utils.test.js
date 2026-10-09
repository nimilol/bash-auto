import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFilename, matchIngredientsByFilename, parseCsvPrompts, parsePrompts,
  itemLabel, randomDelay, slugify, summarize, withAspectRatio,
} from '../lib/utils.js';
import { buildRequest, makeItems, startsNewChat } from '../sidepanel/modes.js';
import { conversationId, extFromUrl, wasInterrupted } from '../sidepanel/engine.js';
import { browserName } from '../lib/browser.js';
import { firefoxManifest } from '../scripts/build.mjs';
import { readFileSync } from 'node:fs';

test('parsePrompts: one per line', () => {
  assert.deepEqual(parsePrompts('first\nsecond\nthird'), ['first', 'second', 'third']);
  assert.deepEqual(parsePrompts('  '), []);
  assert.deepEqual(parsePrompts(null), []);
});

test('parsePrompts: blank lines split multi-line prompts', () => {
  assert.deepEqual(parsePrompts('line 1\nline 2\n\nsecond prompt\n\n\n third '), ['line 1\nline 2', 'second prompt', 'third']);
  assert.deepEqual(parsePrompts('a\r\n\r\nb'), ['a', 'b']);
});

test('parseCsvPrompts: prompt column, quotes, fallback to first column', () => {
  assert.deepEqual(parseCsvPrompts('id,prompt\n1,"hello, world"\n2,"say ""hi"""\n'), ['hello, world', 'say "hi"']);
  assert.deepEqual(parseCsvPrompts('cat\ndog\n'), ['cat', 'dog']);
  assert.deepEqual(parseCsvPrompts('prompt\n"multi\nline"\n'), ['multi\nline']);
});

test('randomDelay: bounds, ordering, negatives', () => {
  assert.equal(randomDelay(2, 5, () => 0), 2000);
  assert.equal(randomDelay(2, 5, () => 1), 5000);
  assert.equal(randomDelay(5, 2, () => 0), 2000);
  assert.equal(randomDelay(-3, 'x', () => 0.5), 0);
  for (let i = 0; i < 100; i++) {
    const d = randomDelay(1, 3);
    assert.ok(d >= 1000 && d <= 3000);
  }
});

test('slugify keeps unicode letters and strips unsafe chars', () => {
  assert.equal(slugify('A cozy cabin: in the snow!'), 'a-cozy-cabin-in-the-snow');
  assert.equal(slugify('Căn nhà gỗ ấm cúng'), 'căn-nhà-gỗ-ấm-cúng');
  assert.equal(slugify('雪中的小木屋 / 夜景'), '雪中的小木屋-夜景');
  assert.equal(slugify('???'), 'output');
  assert.equal(slugify('x'.repeat(200)).length, 50);
});

test('buildFilename', () => {
  assert.equal(buildFilename({ folder: 'My/Proj', index: 0, prompt: 'Hello World', ext: 'png' }), 'My Proj/001-hello-world.png');
  assert.equal(buildFilename({ folder: '', index: 11, prompt: 'x', ext: '.md', part: 1, rename: false }), 'ChatGPT-Automation/012-2.md');
  assert.equal(buildFilename({ folder: 'p', index: 2, prompt: 'x', ext: 'png', part: 0 }), 'p/003-x.png');
  assert.equal(buildFilename({ folder: 'p', index: 2, prompt: 'x', ext: 'png', copy: 1, part: 2 }), 'p/003-x-v2-3.png');
});

test('itemLabel', () => {
  assert.equal(itemLabel({ index: 2 }), '#3');
  assert.equal(itemLabel({ index: 2, copy: 1, copies: 4 }), '#3 (2/4)');
});

test('matchIngredientsByFilename', () => {
  const files = [{ name: 'Alice.png' }, { name: 'bob_smith.jpg' }, { name: 'al.png' }, { name: 'mèo.webp' }];
  const names = (p) => matchIngredientsByFilename(p, files).map((f) => f.name);
  assert.deepEqual(names('Alice meets Bob Smith in the park'), ['Alice.png', 'bob_smith.jpg']);
  assert.deepEqual(names('Totally unrelated'), []);
  assert.deepEqual(names('portrait of alice.'), ['Alice.png']);
  assert.deepEqual(names('một con mèo'), ['mèo.webp']);
  assert.deepEqual(names('also'), []); // "al" must not match inside a word
});

test('withAspectRatio', () => {
  assert.match(withAspectRatio('a cat', '16:9'), /16:9/);
  assert.equal(withAspectRatio('a cat', ''), 'a cat');
});

test('summarize', () => {
  const s = summarize([{ status: 'completed' }, { status: 'failed' }, { status: 'queued' }, { status: 'running' }]);
  assert.deepEqual(s, { total: 4, queued: 1, running: 1, completed: 1, failed: 1, refused: 0, done: 2, percent: 50 });
  const r = summarize([{ status: 'refused' }, { status: 'completed' }]);
  assert.equal(r.refused, 1);
  assert.equal(r.percent, 100);
  assert.equal(summarize([]).percent, 0);
});

test('buildRequest per mode', () => {
  const assets = {
    sourceImages: [{ name: 's1.png', dataUrl: 'd1' }, { name: 's2.png', dataUrl: 'd2' }],
    ingredients: [{ name: 'alice.png', dataUrl: 'a' }, { name: 'bob.png', dataUrl: 'b' }, { name: 'c.png', dataUrl: 'c' }, { name: 'd.png', dataUrl: 'd' }],
  };
  const item = (mode, extra = {}) => ({ prompt: 'Alice waves', index: 1, mode, ...extra });

  assert.deepEqual(buildRequest(item('text'), {}, assets), { prompt: 'Alice waves', files: [], expectImages: false });

  const t2i = buildRequest(item('textToImage'), { aspectRatio: '9:16' }, assets);
  assert.ok(t2i.expectImages);
  assert.match(t2i.prompt, /9:16/);
  assert.deepEqual(t2i.files, []);
  const t2iLast = buildRequest(item('textToImage', { imageMode: 'last' }), {}, assets, { previousImage: { name: 'prev.png', dataUrl: 'p' } });
  assert.deepEqual(t2iLast.files.map((f) => f.name), ['prev.png']);

  const i2i = buildRequest(item('imageToImage'), {}, assets, { promptCount: 2 });
  assert.deepEqual(i2i.files.map((f) => f.name), ['s2.png'], 'one source per prompt when counts match');
  assert.equal(buildRequest(item('imageToImage'), {}, assets, { promptCount: 5 }).files.length, 2);
  assert.equal(buildRequest(item('imageToImage'), { maxImageInputs: 1 }, assets, { promptCount: 5 }).files.length, 1);
  const byName = buildRequest({ ...item('imageToImage'), prompt: 'S1 at the beach' }, { autoAddCharacters: true }, assets, { promptCount: 5 });
  assert.deepEqual(byName.files.map((f) => f.name), ['s1.png'], 'matched by file name');
  const chained = buildRequest(item('imageToImage', { imageMode: 'last' }), {}, assets, { previousImage: { name: 'prev.png', dataUrl: 'p' } });
  assert.deepEqual(chained.files.map((f) => f.name), ['prev.png']);
  assert.throws(() => buildRequest(item('imageToImage'), {}, { sourceImages: [] }));

  assert.deepEqual(buildRequest(item('ingredients'), { autoAddCharacters: true }, assets).files.map((f) => f.name), ['alice.png']);
  assert.equal(buildRequest(item('ingredients'), { autoAddCharacters: false }, assets).files.length, 3, 'capped at 3');
  assert.equal(buildRequest(item('ingredients'), { autoAddCharacters: false, maxIngredientImages: 2 }, assets).files.length, 2);
});

test('makeItems: one item per output, mode options', () => {
  let n = 0;
  const items = makeItems(['a', 'b'], { mode: 'text', firstIndex: 3, outputs: 2, chatMode: 'concat', imageMode: 'last' }, () => `id${n++}`);
  assert.deepEqual(items.map((i) => [i.index, i.copy, i.copies, i.prompt, i.chatMode, i.imageMode]), [
    [3, 0, 2, 'a', 'concat', 'new'], [3, 1, 2, 'a', 'concat', 'new'], [4, 0, 2, 'b', 'concat', 'new'], [4, 1, 2, 'b', 'concat', 'new'],
  ]);
  const img = makeItems(['x'], { mode: 'textToImage', firstIndex: 0, outputs: 99, chatMode: 'concat', imageMode: 'last' });
  assert.equal(img.length, 50);
  assert.equal(img[0].chatMode, 'new');
  assert.equal(img[0].imageMode, 'last');
  assert.equal(img[0].status, 'queued');
});

test('startsNewChat: only after a completed Concat prompt does the chat continue', () => {
  assert.equal(startsNewChat(null), true);
  assert.equal(startsNewChat({ chatMode: 'new', status: 'completed' }), true);
  assert.equal(startsNewChat({ chatMode: 'concat', status: 'completed' }), false);
  assert.equal(startsNewChat({ chatMode: 'concat', status: 'failed' }), true);
});

test('conversationId', () => {
  assert.equal(conversationId('https://chatgpt.com/c/abc-123'), 'abc-123');
  assert.equal(conversationId('https://chatgpt.com/g/g-xyz/c/68d1-ef?model=x'), '68d1-ef');
  assert.equal(conversationId('https://chatgpt.com/'), null);
  assert.equal(conversationId(undefined), null);
});

test('wasInterrupted: only a sent-but-uncollected prompt resumes instead of resending', () => {
  assert.equal(wasInterrupted({ stage: 'reply', error: 'Timed out waiting for the reply' }), true);
  assert.equal(wasInterrupted({ interrupted: true, error: 'The ChatGPT page was reloaded' }), true);
  assert.equal(wasInterrupted({ stage: 'send', error: 'Could not send the prompt' }), false);
  assert.equal(wasInterrupted({ stage: 'chatgpt', error: 'ChatGPT error: something went wrong' }), false);
});

test('browserName: tells the major desktop browsers apart', () => {
  const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
  assert.equal(browserName(chrome), 'Chrome');
  assert.equal(browserName(`${chrome} Edg/140.0.0.0`), 'Edge');
  assert.equal(browserName(`${chrome} OPR/124.0.0.0`), 'Opera');
  assert.equal(browserName('Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0'), 'Firefox');
});

test('firefoxManifest: sidebar + event page, no Chromium-only keys', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  const ff = firefoxManifest(manifest);
  assert.equal(ff.side_panel, undefined);
  assert.ok(!ff.permissions.includes('sidePanel'));
  assert.ok(ff.permissions.includes('menus') && !ff.permissions.includes('contextMenus'));
  assert.deepEqual(ff.background, { scripts: ['background.js'] });
  assert.equal(ff.sidebar_action.default_panel, 'sidepanel/index.html');
  assert.ok(ff.browser_specific_settings.gecko.id);
  assert.equal(manifest.side_panel.default_path, 'sidepanel/index.html', 'source manifest untouched');
});

test('extFromUrl', () => {
  assert.equal(extFromUrl('https://files.oaiusercontent.com/file-abc.webp?se=1&sig=x'), 'webp');
  assert.equal(extFromUrl('https://x.com/a/b.JPEG'), 'jpg');
  assert.equal(extFromUrl('https://chatgpt.com/backend-api/estuary/content?id=file_1'), 'png');
  assert.equal(extFromUrl('not a url'), 'png');
});
