import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODES, buildFilename, buildRequest, chooseChat, conversationId, makeItems, matchImagesByName, normalizeSettings, parseCsvPrompts,
  parsePrompts, randomDelay, slugify, summarize, withAspectRatio, chatUrlFor,
} from '../../lib/utils.js';

test('parsePrompts: lines, or blocks separated by blank lines', () => {
  assert.deepEqual(parsePrompts('a\nb\n\n'), ['a', 'b']);
  assert.deepEqual(parsePrompts('line one\nline two\n\nsecond'), ['line one\nline two', 'second']);
  assert.deepEqual(parsePrompts('  '), []);
});

test('parseCsvPrompts: prompt column or first column, quotes', () => {
  assert.deepEqual(parseCsvPrompts('id,prompt\n1,"a, b"\n2,"say ""hi"""'), ['a, b', 'say "hi"']);
  assert.deepEqual(parseCsvPrompts('cat\ndog'), ['cat', 'dog']);
});

test('filenames', () => {
  assert.equal(buildFilename({ folder: 'Out', index: 0, prompt: 'A red Fox!', ext: 'png' }), 'Out/001-a-red-fox.png');
  assert.equal(buildFilename({ folder: 'Out', index: 9, prompt: 'x', ext: 'png', copy: 1, part: 2 }), 'Out/010-x-v2-3.png');
  assert.equal(buildFilename({ folder: '../bad:name', index: 0, prompt: 'x', ext: 'png', rename: false }), 'bad name/001.png');
  assert.equal(slugify('Mèo con 猫'), 'mèo-con-猫');
});

test('settings are clamped', () => {
  const s = normalizeSettings({ minDelay: 10, maxDelay: 2, maxRetries: 99, chatPolicy: 'x', imageWaitMin: -4 });
  assert.equal(s.maxDelay, 10);
  assert.equal(s.maxRetries, 20);
  assert.equal(s.chatPolicy, 'same');
  assert.equal(s.imageWaitMin, 0.1);
  assert.equal(normalizeSettings({}).mode, MODES.TEXT_TO_IMAGE);
});

test('chooseChat: one chat for the whole run', () => {
  const s = normalizeSettings({});
  assert.deepEqual(chooseChat({}, { convId: '' }, s), { kind: 'new' });
  assert.deepEqual(chooseChat({}, { convId: 'c1' }, s), { kind: 'chat', convId: 'c1' });
  // A prompt that already reached a chat always goes back there.
  assert.deepEqual(chooseChat({ convId: 'c0' }, { convId: 'c1' }, s), { kind: 'chat', convId: 'c0' });
  assert.deepEqual(chooseChat({ newChat: true }, { convId: 'c1' }, s), { kind: 'new' });
  assert.deepEqual(chooseChat({}, { convId: 'c1' }, normalizeSettings({ chatPolicy: 'perPrompt' })), { kind: 'new' });
  assert.deepEqual(chooseChat({}, { convId: '' }, normalizeSettings({ startIn: 'current' })), { kind: 'current' });
});

test('buildRequest per mode', () => {
  const s = normalizeSettings({ aspectRatio: '16:9' });
  const img = { name: 'hero.png', dataUrl: 'data:image/png;base64,AA' };
  const r = buildRequest({ prompt: 'a hero', mode: MODES.TEXT_TO_IMAGE, index: 0 }, s);
  assert.equal(r.prompt, withAspectRatio('a hero', '16:9'));
  assert.equal(r.expectImages, true);
  assert.deepEqual(buildRequest({ prompt: 'p', mode: MODES.TEXT_TO_IMAGE, imageMode: 'last', index: 0 }, s, {}, img).files, [img]);
  assert.throws(() => buildRequest({ prompt: 'p', mode: MODES.IMAGE_TO_IMAGE, index: 0 }, s, { sourceImages: [] }));
  assert.deepEqual(buildRequest({ prompt: 'the hero walks', mode: MODES.IMAGE_TO_IMAGE, index: 0 }, s, { sourceImages: [img, { name: 'b.png' }] }).files, [img]);
  const t = buildRequest({ prompt: 'hi', mode: MODES.TEXT, index: 0 }, s);
  assert.equal(t.prompt, 'hi');
  assert.equal(t.expectImages, false);
});

test('makeItems, matching, summary, misc', () => {
  const items = makeItems(['a', 'b'], { mode: MODES.TEXT_TO_IMAGE, firstIndex: 3, outputs: 2 }, (() => { let n = 0; return () => `id${n++}`; })());
  assert.equal(items.length, 4);
  assert.deepEqual(items.map((i) => [i.index, i.copy]), [[3, 0], [3, 1], [4, 0], [4, 1]]);
  assert.deepEqual(matchImagesByName('the old_man and hero', [{ name: 'old_man.png' }, { name: 'hero.jpg' }, { name: 'her.png' }]).map((f) => f.name), ['old_man.png', 'hero.jpg']);
  assert.equal(summarize([{ status: 'completed' }, { status: 'failed' }, { status: 'queued' }]).percent, 67);
  assert.equal(conversationId('https://chatgpt.com/g/g-x/c/68e1aaaa-0001-abc'), '68e1aaaa-0001-abc');
  assert.equal(conversationId('https://chatgpt.com/'), '');
  assert.equal(chatUrlFor('abc12345', 'https://chat.openai.com/'), 'https://chat.openai.com/c/abc12345');
  const ms = randomDelay(2, 4, () => 0.5);
  assert.equal(ms, 3000);
});
