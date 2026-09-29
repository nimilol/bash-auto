import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFilename, matchIngredientsByFilename, parseCsvPrompts, parsePrompts,
  randomDelay, slugify, summarize, withAspectRatio,
} from '../lib/utils.js';
import { buildRequest, wantsNewChat } from '../sidepanel/modes.js';

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
  assert.equal(
    buildFilename({ project: 'My/Proj', index: 0, prompt: 'Hello World', ext: 'png' }),
    'ChatGPT-Automation/My Proj/001-hello-world.png',
  );
  assert.equal(
    buildFilename({ project: '', index: 11, prompt: 'x', ext: '.md', part: 1, renameByPrompt: false }),
    'ChatGPT-Automation/default/012-2.md',
  );
  assert.equal(buildFilename({ project: 'p', index: 2, prompt: 'x', ext: 'png', part: 0 }), 'ChatGPT-Automation/p/003-x.png');
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
  assert.deepEqual(s, { total: 4, queued: 1, running: 1, completed: 1, failed: 1, done: 2, percent: 50 });
  assert.equal(summarize([]).percent, 0);
});

test('buildRequest per mode', () => {
  const assets = {
    sourceImages: [{ name: 's1.png', dataUrl: 'd1' }, { name: 's2.png', dataUrl: 'd2' }],
    ingredients: [{ name: 'alice.png', dataUrl: 'a' }, { name: 'bob.png', dataUrl: 'b' }],
  };
  const item = { prompt: 'Alice waves', index: 1 };

  const text = buildRequest(item, { mode: 'text' }, assets);
  assert.deepEqual(text, { prompt: 'Alice waves', files: [], expectImages: false });

  const t2i = buildRequest(item, { mode: 'textToImage', aspectRatio: '9:16' }, assets);
  assert.ok(t2i.expectImages);
  assert.match(t2i.prompt, /9:16/);

  const i2i = buildRequest(item, { mode: 'imageToImage', queueLength: 2 }, assets);
  assert.deepEqual(i2i.files.map((f) => f.name), ['s2.png']); // one source per prompt
  const i2iAll = buildRequest(item, { mode: 'imageToImage', queueLength: 5 }, assets);
  assert.equal(i2iAll.files.length, 2);
  const chained = buildRequest(item, { mode: 'imageToImage', chain: true }, assets, { previousImage: { name: 'prev.png', dataUrl: 'p' } });
  assert.deepEqual(chained.files.map((f) => f.name), ['prev.png']);
  assert.throws(() => buildRequest(item, { mode: 'imageToImage' }, { sourceImages: [] }));

  const ing = buildRequest(item, { mode: 'ingredients', autoMatchIngredients: true }, assets);
  assert.deepEqual(ing.files.map((f) => f.name), ['alice.png']);
  const ingAll = buildRequest(item, { mode: 'ingredients', autoMatchIngredients: false }, assets);
  assert.equal(ingAll.files.length, 2);
});

test('wantsNewChat', () => {
  assert.equal(wantsNewChat({ mode: 'text', concat: true, newChatPerPrompt: true }, false), false);
  assert.equal(wantsNewChat({ mode: 'text', concat: true }, true), true);
  assert.equal(wantsNewChat({ mode: 'text', newChatPerPrompt: true }, false), true);
  assert.equal(wantsNewChat({ mode: 'text', newChatPerPrompt: false, newChatOnStart: true }, true), true);
  assert.equal(wantsNewChat({ mode: 'text', newChatPerPrompt: false, newChatOnStart: false }, true), false);
});
