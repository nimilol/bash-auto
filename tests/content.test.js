// Unit tests for the page-side readers: content/sse.js (reply stream) and content/conversation.js
// (GET /backend-api/conversation/<id>). They are classic scripts, so they're loaded into a VM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = vm.createContext({});
for (const f of ['content/sse.js', 'content/conversation.js']) vm.runInContext(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'), ctx);
const { CGA_SSE: SSE, CGA_CONV: CONV } = ctx;
const plain = (v) => JSON.parse(JSON.stringify(v));

/** Feed a stream in awkward chunks and return the summary. */
function summarizeStream(text, chunk = 7) {
  const sum = SSE.newSummary();
  const parser = SSE.createParser((ev) => SSE.summarize(sum, ev));
  for (let i = 0; i < text.length; i += chunk) parser.feed(text.slice(i, i + chunk));
  parser.end();
  return sum;
}

const CID = '68e1f0aa-1111-2222-3333-444455556666';
// The 2025+ "delta encoding v1" stream: an add with the message, then patches and bare string appends.
const TEXT_STREAM = [
  'event: delta_encoding\ndata: "v1"\n\n',
  `data: {"type": "resume_conversation_token", "token": "x", "conversation_id": "${CID}"}\n\n`,
  `event: delta\ndata: {"p": "", "o": "add", "v": {"message": {"id": "a1", "author": {"role": "assistant", "name": null}, "content": {"content_type": "text", "parts": [""]}, "status": "in_progress", "end_turn": null, "metadata": {}, "recipient": "all"}, "conversation_id": "${CID}", "error": null}, "c": 0}\n\n`,
  'event: delta\ndata: {"o": "patch", "v": [{"p": "/message/content/parts/0", "o": "append", "v": "Hello"}]}\n\n',
  'event: delta\ndata: {"v": " world"}\n\n',
  `data: {"type": "message_stream_complete", "conversation_id": "${CID}"}\n\n`,
  'data: [DONE]\n\n',
].join('');

test('sse: conversation id, event types and [DONE] from a v1 delta stream, in any chunking', () => {
  for (const chunk of [1, 7, 64, 10000]) {
    const sum = summarizeStream(TEXT_STREAM, chunk);
    assert.equal(sum.convId, CID);
    assert.equal(sum.done, true);
    assert.equal(sum.error, '');
    assert.equal(sum.imageTask, false);
    assert.ok(sum.types.includes('message_stream_complete'));
    assert.ok(sum.types.includes('event:delta_encoding'));
    assert.equal(sum.messages, 1);
  }
});

test('sse: the older full-message format and CRLF line endings', () => {
  const old = `data: {"message": {"id": "a1", "author": {"role": "assistant"}, "content": {"content_type": "text", "parts": ["Hi"]}, "status": "finished_successfully", "end_turn": true}, "conversation_id": "${CID}", "error": null}\r\n\r\ndata: [DONE]\r\n\r\n`;
  const sum = summarizeStream(old);
  assert.equal(sum.convId, CID);
  assert.equal(sum.done, true);
  assert.equal(sum.messages, 1);
});

test('sse: image generation is recognized from the tool name or the async task', () => {
  const tool = `data: {"v": {"message": {"id": "t1", "author": {"role": "tool", "name": "t2uay3k.sj1i4kz"}, "content": {"content_type": "multimodal_text", "parts": [{"content_type": "image_asset_pointer", "asset_pointer": "sediment://file_abc"}]}, "status": "finished_successfully", "metadata": {}}, "conversation_id": "${CID}"}}\n\n`;
  const sum = summarizeStream(tool);
  assert.equal(sum.imageTask, true);
  assert.equal(sum.imagePointers, 1);
  const async = `data: {"message": {"id": "t2", "author": {"role": "tool", "name": "x"}, "content": {"content_type": "text", "parts": ["Processing image"]}, "metadata": {"image_gen_async": true, "async_task_id": "task_1"}}}\n\n`;
  assert.equal(summarizeStream(async).imageTask, true);
});

test('sse: error events', () => {
  assert.match(summarizeStream('data: {"message": null, "conversation_id": "c", "error": "Something went wrong while generating the response."}\n\n').error, /Something went wrong/);
  assert.match(summarizeStream('data: {"type": "error", "message": "Rate limit exceeded"}\n\n').error, /Rate limit/);
  assert.equal(summarizeStream('data: {"v": {"message": {"author": {"role": "assistant"}, "content": {}}, "error": null}}\n\n').error, '');
  assert.equal(summarizeStream('data: not json\n\n').events, 1, 'unknown payloads are ignored');
});

test('sse: request body gives the user message id and text', () => {
  const body = JSON.stringify({
    action: 'next',
    messages: [{ id: 'u-1', author: { role: 'user' }, content: { content_type: 'multimodal_text', parts: [{ asset_pointer: 'x' }, 'draw a cat'] } }],
    conversation_id: CID,
    parent_message_id: 'p',
  });
  assert.deepEqual(plain(SSE.readRequestBody(body)), { userId: 'u-1', userText: 'draw a cat', convId: CID, action: 'next' });
  assert.deepEqual(plain(SSE.readRequestBody('not json')), { userId: '', userText: '', convId: '', action: '' });
  assert.deepEqual(plain(SSE.readRequestBody(undefined)), { userId: '', userText: '', convId: '', action: '' });
});

// ---- conversation.js ----------------------------------------------------------------------------

/** Build a conversation the way the backend returns it: a mapping of nodes linked by parent/children. */
function conversation(messages) {
  const mapping = { root: { id: 'root', message: null, parent: null, children: [] } };
  let parent = 'root';
  for (const m of messages) {
    mapping[m.id] = { id: m.id, message: m, parent, children: [] };
    mapping[parent].children.push(m.id);
    parent = m.id;
  }
  return { conversation_id: CID, current_node: parent, mapping };
}
const user = (id, text) => ({ id, author: { role: 'user' }, content: { content_type: 'text', parts: [text] }, status: 'finished_successfully', recipient: 'all' });
const assistant = (id, text, extra = {}) => ({ id, author: { role: 'assistant' }, content: { content_type: 'text', parts: [text] }, status: 'finished_successfully', end_turn: true, recipient: 'all', ...extra });
const system = { id: 's', author: { role: 'system' }, content: { content_type: 'text', parts: [''] }, metadata: { is_visually_hidden_from_conversation: true } };
const thoughts = { id: 'th', author: { role: 'assistant' }, content: { content_type: 'thoughts', thoughts: [] }, status: 'finished_successfully', end_turn: false, recipient: 'all' };
const imageCall = { id: 'ic', author: { role: 'assistant' }, content: { content_type: 'code', text: '{"prompt":"a cat"}' }, status: 'finished_successfully', end_turn: false, recipient: 't2uay3k.sj1i4kz' };
const imageResult = (pointer = 'sediment://file_abc') => ({
  id: 'ir', author: { role: 'tool', name: 't2uay3k.sj1i4kz' }, status: 'finished_successfully', recipient: 'all',
  content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: pointer, width: 1024, height: 1024 }] },
  metadata: { async_task_id: 'task_1', image_gen_async: true },
});

test('conversation: finished text reply after reasoning', () => {
  const a = CONV.analyze(conversation([system, user('u1', 'first'), assistant('a1', 'one'), user('u2', 'Write a poem'), thoughts, assistant('a2', 'Roses are red')]), { prompt: 'Write a poem' });
  assert.equal(a.anchor, true);
  assert.equal(a.anchorId, 'u2');
  assert.equal(a.final, true);
  assert.equal(a.text, 'Roses are red');
  assert.deepEqual(plain(a.images), []);
});

test('conversation: not finished while the reply is in progress, missing, or a tool call', () => {
  const p = { prompt: 'Write a poem' };
  assert.equal(CONV.analyze(conversation([user('u1', 'Write a poem')]), p).final, false, 'no reply yet');
  assert.equal(CONV.analyze(conversation([user('u1', 'Write a poem'), thoughts]), p).final, false, 'only reasoning');
  assert.equal(CONV.analyze(conversation([user('u1', 'Write a poem'), assistant('a', 'Ros', { status: 'in_progress', end_turn: null })]), p).final, false);
  assert.equal(CONV.analyze(conversation([user('u1', 'Write a poem'), assistant('a', 'Let me search', { end_turn: false })]), p).final, false);
  assert.equal(CONV.analyze(conversation([user('u1', 'Write a poem'), imageCall]), p).final, false);
  assert.equal(CONV.analyze(conversation([user('u1', 'something else')]), p).anchor, false);
});

test('conversation: image reply, pending image, and the tool note after it', () => {
  const p = { prompt: 'draw a cat' };
  const pending = { ...imageResult(), content: { content_type: 'text', parts: ['Processing image'] }, status: 'in_progress' };
  const waiting = CONV.analyze(conversation([user('u', 'draw a cat'), imageCall, pending]), p);
  assert.equal(waiting.final, false);
  assert.equal(waiting.imagePending, true);

  const done = CONV.analyze(conversation([user('u', 'draw a cat'), imageCall, imageResult()]), p);
  assert.equal(done.final, true);
  assert.deepEqual(plain(done.images), ['sediment://file_abc']);
  assert.equal(done.imagePending, false);

  const note = { id: 'n', author: { role: 'tool', name: 't2uay3k.sj1i4kz' }, content: { content_type: 'text', parts: ['GPT-4o returned 1 images.'] }, status: 'finished_successfully', recipient: 'all' };
  assert.equal(CONV.analyze(conversation([user('u', 'draw a cat'), imageCall, imageResult(), note]), p).final, true);
  const withText = CONV.analyze(conversation([user('u', 'draw a cat'), imageCall, imageResult(), assistant('a', 'Here it is!')]), p);
  assert.equal(withText.final, true);
  assert.equal(withText.text, 'Here it is!');
});

test('conversation: the prompt is found by message id first, then by its text (latest match)', () => {
  const conv = conversation([user('u1', 'same prompt'), assistant('a1', 'first'), user('u2', 'same prompt'), assistant('a2', 'second')]);
  assert.equal(CONV.analyze(conv, { prompt: 'same prompt' }).text, 'second');
  assert.equal(CONV.analyze(conv, { userId: 'u1', prompt: 'same prompt' }).text, 'first\n\nsecond');
  const long = 'A highly detailed photorealistic picture of a quiet harbor town at dawn, soft light';
  const conv2 = conversation([user('u', `${long}\n\nGenerate an image. Aspect ratio: square 1:1.`), assistant('a', 'ok')]);
  assert.equal(CONV.analyze(conv2, { prompt: `${long}  \nGenerate an image. Aspect ratio: square 1:1.` }).anchor, true, 'whitespace differences');
});

test('conversation: a reworded prompt is found as the latest user message sent since ours', () => {
  const now = 1760000000;
  const conv = conversation([{ ...user('u1', 'older'), create_time: now - 600 }, assistant('a1', 'x'), { ...user('u2', 'ChatGPT reworded this'), create_time: now + 1 }, assistant('a2', 'reply')]);
  assert.equal(CONV.analyze(conv, { prompt: 'what we typed', since: now }).text, 'reply');
  assert.equal(CONV.analyze(conv, { prompt: 'what we typed' }).anchor, false, 'no fallback without a send time');
  assert.equal(CONV.analyze(conv, { prompt: 'what we typed', since: now + 1000 }).anchor, false, 'an older message is not ours');
});

test('conversation: a question back, then the nudge and the image, all after our prompt', () => {
  const conv = conversation([user('u', 'draw a fox'), assistant('q', 'Landscape or portrait?'), user('n', 'Yes, please generate the image now.'), imageCall, imageResult('file-service://file-XYZ')]);
  const a = CONV.analyze(conv, { prompt: 'draw a fox' });
  assert.equal(a.final, true);
  assert.deepEqual(plain(a.images), ['file-service://file-XYZ']);
  assert.equal(a.lastText, 'Landscape or portrait?');
});

test('conversation: branch follows current_node, not other edits', () => {
  const conv = conversation([user('u', 'hello'), assistant('a', 'old answer')]);
  conv.mapping.b = { id: 'b', parent: 'u', children: [], message: assistant('b', 'regenerated answer') };
  conv.mapping.u.children.push('b');
  conv.current_node = 'b';
  assert.equal(CONV.analyze(conv, { prompt: 'hello' }).text, 'regenerated answer');
});
