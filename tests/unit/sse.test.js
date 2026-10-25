// The reply-stream parser used by the page hook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../content/sse.js';

const { createParser, newSummary, summarize, readRequestBody, isTooLong, isNetworkError } = globalThis.CGA_SSE;

function run(chunks) {
  const sum = newSummary();
  const p = createParser((ev) => summarize(sum, ev));
  chunks.forEach((c) => p.feed(c));
  p.end();
  return sum;
}

test('conversation id, image task and done, across chunk boundaries', () => {
  const msg = { message: { author: { role: 'tool', name: 't2uay3k.sj1i4kz' }, content: { parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'sediment://x' }] }, metadata: {} }, conversation_id: 'c-1' };
  const text = `event: delta_encoding\ndata: "v1"\n\nevent: delta\ndata: ${JSON.stringify({ v: msg, c: 1 })}\n\ndata: [DONE]\n\n`;
  const sum = run([text.slice(0, 40), text.slice(40, 90), text.slice(90)]);
  assert.equal(sum.convId, 'c-1');
  assert.equal(sum.imageTask, true);
  assert.equal(sum.imagePointers, 1);
  assert.equal(sum.done, true);
  assert.ok(sum.types.includes('event:delta_encoding'));
});

test('error events and too-long detection', () => {
  const sum = run([`data: ${JSON.stringify({ message: null, conversation_id: 'c', error: 'Conversation too long. Please start a new chat.' })}\n\n`]);
  assert.match(sum.error, /too long/);
  assert.equal(sum.tooLong, true);
  assert.ok(isTooLong('maximum conversation length'));
  assert.ok(!isTooLong('rate limit'));
});

test('request body', () => {
  const body = JSON.stringify({ action: 'next', conversation_id: 'c9', messages: [{ id: 'm1', author: { role: 'user' }, content: { parts: ['hello'] } }] });
  assert.deepEqual(readRequestBody(body), { userId: 'm1', userText: 'hello', convId: 'c9', action: 'next' });
  assert.equal(readRequestBody('not json').userId, '');
});

test('network error detection', () => {
  assert.ok(isNetworkError('Failed to fetch'));
  assert.ok(isNetworkError('network error'));
  assert.ok(!isNetworkError('Something went wrong'));
});
