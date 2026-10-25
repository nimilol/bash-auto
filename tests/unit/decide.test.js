// The decision that says whether a prompt's reply is done, still coming, or failed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../content/decide.js';

const { decide, refusalIn, asksQuestion } = globalThis.CGA_DECIDE;
const MIN = 60000;
const T0 = 1_000_000;

const job = (o = {}) => ({
  expectImages: true, nudged: false, canNudge: true, sentAt: T0, lastChange: T0, imagesChangedAt: T0, finalCheckDone: false,
  quietMs: 3 * MIN, capMs: 30 * MIN, staleMs: 10 * MIN, ...o,
});
const analysis = (o = {}) => ({
  anchor: true, final: false, text: '', lastText: '', images: [], partials: 0, imageTask: false, imagePending: false,
  inProgress: false, turnOpen: false, laterPrompt: false, error: '', ...o,
});
const sig = (o = {}) => ({ now: T0, online: true, stream: { open: false, ended: true }, json: analysis(), jsonNetworkFails: 0, dom: { images: 0, promptShown: true }, ...o });

test('image done: new image, nothing generating, stable for 5 s', () => {
  const j = job({ imagesChangedAt: T0 });
  assert.equal(decide(j, sig({ now: T0 + 4000, json: analysis({ images: ['p1'], final: true }) })).type, 'wait');
  assert.deepEqual(decide(j, sig({ now: T0 + 5000, json: analysis({ images: ['p1'], final: true }) })), { type: 'collect', source: 'network' });
});

test('image done from the page alone (conversation unreadable)', () => {
  const d = decide(job(), sig({ now: T0 + 6000, json: null, dom: { images: 1, promptShown: true } }));
  assert.deepEqual(d, { type: 'collect', source: 'page' });
});

test('more images still coming: waits while a message is in progress', () => {
  const d = decide(job(), sig({ now: T0 + 30000, json: analysis({ images: ['p1'], inProgress: true }) }));
  assert.deepEqual(d, { type: 'wait', status: 'image' });
});

test('stale "generating" marker with an image present does not hold the queue forever', () => {
  const j = job({ lastChange: T0, imagesChangedAt: T0 });
  const d = decide(j, sig({ now: T0 + 91000, dom: { images: 1, generating: true, promptShown: true }, json: analysis({ images: ['p1'] }) }));
  assert.equal(d.type, 'collect');
});

test('never fails while ChatGPT shows it is still working on the image', () => {
  for (const s of [
    { stream: { open: true } },
    { json: analysis({ inProgress: true, imageTask: true }) },
    { json: analysis({ imagePending: true, imageTask: true }) },
    { json: analysis({ turnOpen: true }) },
    { dom: { images: 0, generating: true, promptShown: true } },
    { dom: { images: 0, stop: true, promptShown: true } },
  ]) {
    // Long after the no-image quiet window, but things are still changing.
    const j = job({ lastChange: T0 + 8 * MIN });
    const d = decide(j, sig({ now: T0 + 9 * MIN, ...s }));
    assert.equal(d.type, 'wait', JSON.stringify(s));
  }
});

test('the regression: an async image that lands minutes after the reply text is not failed', () => {
  // ChatGPT says it is creating the image, the stream closes, the image task shows no image yet.
  const j = job({ lastChange: T0 });
  const json = analysis({ imageTask: true, imagePending: true, text: 'Creating image…', lastText: 'Creating image…' });
  for (const t of [1, 2, 4, 6, 9]) assert.equal(decide(j, sig({ now: T0 + t * MIN, json })).type, 'wait', `${t} min`);
});

test('working text keeps waiting even without other signals', () => {
  const j = job({ lastChange: T0 });
  const json = analysis({ text: 'Lots of people are creating images right now, so this might take a bit.', lastText: 'Lots of people are creating images right now, so this might take a bit.' });
  assert.equal(decide(j, sig({ now: T0 + 5 * MIN, json })).type, 'wait');
});

test('long silence while "working" ends as interrupted (stale), not as a failure', () => {
  const j = job({ lastChange: T0 });
  const d = decide(j, sig({ now: T0 + 10 * MIN + 1, json: analysis({ imagePending: true, imageTask: true }) }));
  assert.equal(d.type, 'error');
  assert.equal(d.kind, 'stale');
});

test('hard cap ends as "cap" (interrupted, not resent)', () => {
  const j = job({ lastChange: T0 + 30 * MIN });
  const d = decide(j, sig({ now: T0 + 30 * MIN, stream: { open: true } }));
  assert.equal(d.kind, 'cap');
});

test('no image: only after the quiet window, one last look, then a nudge, then failure', () => {
  const json = analysis({ final: true, text: 'Here is a description of a cat.', lastText: 'Here is a description of a cat.' });
  const j = job();
  assert.equal(decide(j, sig({ now: T0 + 2 * MIN, json })).type, 'wait');
  assert.equal(decide(j, sig({ now: T0 + 3 * MIN, json })).type, 'finalCheck');
  j.finalCheckDone = true;
  assert.equal(decide(j, sig({ now: T0 + 3 * MIN, json })).type, 'nudge');
  j.nudged = true;
  const d = decide(j, sig({ now: T0 + 3 * MIN, json }));
  assert.equal(d.type, 'error');
  assert.equal(d.kind, 'noImage');
});

test('question back: one nudge after 3 s', () => {
  const json = analysis({ final: true, text: 'Would you like it in landscape or portrait?', lastText: 'Would you like it in landscape or portrait?' });
  assert.equal(decide(job(), sig({ now: T0 + 2000, json })).type, 'wait');
  assert.equal(decide(job(), sig({ now: T0 + 3000, json })).type, 'nudge');
  assert.equal(decide(job({ nudged: true }), sig({ now: T0 + 3000, json })).type, 'wait');
});

test('refusal is reported as refused', () => {
  const json = analysis({ final: true, text: "I can't create that image because it violates our content policies." });
  const d = decide(job(), sig({ now: T0 + 4000, json }));
  assert.equal(d.type, 'refused');
});

test('offline and unreachable are network problems, not failures', () => {
  assert.equal(decide(job(), sig({ online: false })).type, 'network');
  assert.equal(decide(job(), sig({ jsonNetworkFails: 3 })).type, 'network');
  assert.equal(decide(job(), sig({ json: null, stream: { ended: true, aborted: true, network: true, error: 'network error' } })).type, 'network');
});

test('a dropped stream with the conversation still readable keeps following', () => {
  const d = decide(job({ lastChange: T0 + 20000 }), sig({ now: T0 + 30000, stream: { ended: true, aborted: true, network: true }, json: analysis({ imagePending: true, imageTask: true }) }));
  assert.equal(d.type, 'wait');
});

test('ChatGPT errors: stream error, rate limit, too long', () => {
  assert.equal(decide(job(), sig({ stream: { ended: true, error: 'Something went wrong' } })).kind, 'chatgpt');
  assert.equal(decide(job(), sig({ stream: { ended: true, status: 429, error: "You've reached our limit" } })).kind, 'chatgpt');
  assert.equal(decide(job(), sig({ stream: { ended: true, error: 'Conversation too long', tooLong: true } })).kind, 'tooLong');
});

test('an error shown on the page with nothing happening fails after 20 s (to be resent)', () => {
  const s = sig({ now: T0 + 25000, json: analysis({ final: false }), dom: { images: 0, promptShown: true, error: 'network error' } });
  assert.equal(decide(job(), s).kind, 'chatgpt');
  assert.equal(decide(job(), { ...s, now: T0 + 10000 }).type, 'wait');
});

test('an error in the reply ends a wait held only by an "in progress" mark in the data', () => {
  const json = analysis({ inProgress: true, imageTask: true, imagePending: true });
  const s = sig({ now: T0 + 25000, json, dom: { images: 0, promptShown: true, replyError: 'something went wrong' } });
  assert.equal(decide(job(), s).kind, 'chatgpt');
  // Not while the page itself shows work going on, and not with an image.
  assert.equal(decide(job(), { ...s, dom: { ...s.dom, generating: true } }).type, 'wait');
  assert.equal(decide(job({ imagesChangedAt: T0 }), { ...s, json: analysis({ images: ['p'] }) }).type, 'collect');
});

test('prompt never reached the chat: "lost" after 90 s', () => {
  const s = sig({ json: { anchor: false }, dom: { images: 0, promptShown: false } });
  assert.equal(decide(job(), { ...s, now: T0 + 60000 }).type, 'wait');
  assert.equal(decide(job(), { ...s, now: T0 + 91000 }).kind, 'lost');
});

test('text prompts: done when final; page fallback with action bar', () => {
  const tj = job({ expectImages: false });
  assert.equal(decide(tj, sig({ now: T0 + 1000, json: analysis({ final: true, text: 'hi' }) })).type, 'wait');
  assert.equal(decide(tj, sig({ now: T0 + 2000, json: analysis({ final: true, text: 'hi' }) })).type, 'collect');
  assert.equal(decide(tj, sig({ now: T0 + 3000, json: null, dom: { text: 'hi', actionBar: true, promptShown: true } })).type, 'collect');
  assert.equal(decide(tj, sig({ now: T0 + 3000, json: null, dom: { text: 'hi', stop: true, promptShown: true } })).type, 'wait');
});

test('refusal and question detection', () => {
  assert.ok(refusalIn('I’m unable to generate that image.'));
  assert.equal(refusalIn('Here is your image of a cat.'), '');
  assert.ok(asksQuestion('Landscape or portrait?'));
  assert.ok(!asksQuestion('Here you go.'));
});
