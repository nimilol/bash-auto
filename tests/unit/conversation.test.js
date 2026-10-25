// Reading ChatGPT's conversation data: anchors, images, progress, long single chats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../content/conversation.js';

const { analyze, allPointers, findAnchor, branch } = globalThis.CGA_CONV;

let seq = 0;
const msg = (role, o = {}) => ({
  id: o.id || `${role}-${++seq}`,
  author: { role, name: o.name || null },
  content: o.content || { content_type: 'text', parts: [o.text ?? ''] },
  status: o.status ?? 'finished_successfully',
  end_turn: o.end_turn ?? (role === 'assistant' ? true : null),
  recipient: o.recipient || 'all',
  metadata: o.metadata || {},
  create_time: o.create_time ?? 1000 + seq,
});
const image = (pointer, o = {}) => msg('tool', {
  name: 't2uay3k.sj1i4kz',
  metadata: { image_gen_async: true },
  content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: pointer, metadata: o.partial ? { generation: { partial: true } } : {} }] },
  ...o,
});
const call = () => msg('assistant', { recipient: 't2uay3k.sj1i4kz', end_turn: false, content: { content_type: 'code', text: '{}' } });

function conv(messages) {
  const mapping = { root: { id: 'root', message: null, parent: null, children: [] } };
  let parent = 'root';
  for (const m of messages) {
    mapping[m.id] = { id: m.id, message: m, parent, children: [] };
    mapping[parent].children.push(m.id);
    parent = m.id;
  }
  return { mapping, current_node: parent };
}

test('finished image after our prompt', () => {
  const u = msg('user', { text: 'a red fox' });
  const a = analyze(conv([u, call(), image('sediment://file_1')]), { userId: u.id });
  assert.equal(a.anchor, true);
  assert.deepEqual(a.images, ['sediment://file_1']);
  assert.equal(a.final, true);
  assert.equal(a.inProgress, false);
  assert.equal(a.turnOpen, false);
});

test('image in progress / async task without image', () => {
  const u = msg('user', { text: 'a fox' });
  const pending = analyze(conv([u, call(), msg('tool', { name: 't2uay3k.sj1i4kz', text: 'Processing image', status: 'in_progress', metadata: { image_gen_async: true } })]), { userId: u.id });
  assert.equal(pending.inProgress, true);
  assert.equal(pending.imagePending, true);
  assert.equal(pending.final, false);
  // Finished tool message saying "processing", no image yet: still pending (the old false failure).
  const quiet = analyze(conv([u, call(), msg('tool', { name: 't2uay3k.sj1i4kz', text: 'Processing image. Lots of people are creating images right now.', metadata: { image_gen_async: true } })]), { userId: u.id });
  assert.equal(quiet.imagePending, true);
  assert.equal(quiet.images.length, 0);
});

test('partial previews are not counted as images', () => {
  const u = msg('user', { text: 'a fox' });
  const a = analyze(conv([u, call(), image('sediment://p', { partial: true, status: 'in_progress' })]), { userId: u.id });
  assert.deepEqual(a.images, []);
  assert.equal(a.partials, 1);
  assert.equal(a.inProgress, true);
});

test('two images in one reply', () => {
  const u = msg('user', { text: 'two foxes' });
  const a = analyze(conv([u, call(), image('sediment://a'), image('sediment://b'), msg('assistant', { text: 'Here they are.' })]), { userId: u.id });
  assert.deepEqual(a.images, ['sediment://a', 'sediment://b']);
  assert.equal(a.final, true);
  assert.equal(a.text, 'Here they are.');
});

test('long single chat: older images are ignored via baseline and anchor after the previous prompt', () => {
  const msgs = [];
  const users = [];
  for (let i = 0; i < 20; i++) {
    const u = msg('user', { text: 'same prompt again' });
    users.push(u);
    msgs.push(u, call(), image(`sediment://img${i}`));
  }
  const latest = msgs.slice(0, -2); // our newest prompt has no image yet
  const c = conv(latest);
  const baseline = allPointers(conv(msgs.slice(0, -3)));
  assert.equal(baseline.length, 19);
  // By text, after the previous prompt's message: our newest prompt, not an older copy.
  const a = analyze(c, { prompt: 'same prompt again', afterId: users[18].id, baseline });
  assert.equal(a.anchor, true);
  assert.equal(a.anchorId, users[19].id);
  assert.deepEqual(a.images, []);
  assert.equal(a.turnOpen, true);
  // Then its image lands.
  const done = analyze(conv(msgs), { userId: users[19].id, baseline });
  assert.deepEqual(done.images, ['sediment://img19']);
});

test('a later prompt that is not ours bounds the reply', () => {
  const u = msg('user', { text: 'first prompt here please' });
  const other = msg('user', { text: 'something else entirely' });
  const a = analyze(conv([u, call(), image('sediment://x'), other, call(), image('sediment://y')]), { userId: u.id });
  assert.deepEqual(a.images, ['sediment://x']);
  assert.equal(a.laterPrompt, true);
});

test('our own follow-up (nudge) stays part of the reply', () => {
  const nudge = 'Yes, please generate the image now, exactly as described.';
  const u = msg('user', { text: 'ask first: a hat' });
  const a = analyze(conv([u, msg('assistant', { text: 'Landscape or portrait?' }), msg('user', { text: nudge }), call(), image('sediment://h')]), { userId: u.id, followUps: [nudge] });
  assert.deepEqual(a.images, ['sediment://h']);
  assert.equal(a.laterPrompt, false);
});

test('anchor by id, by text, by time', () => {
  const u1 = msg('user', { text: 'hello world prompt number one', create_time: 100 });
  const u2 = msg('user', { text: 'another prompt that is long enough', create_time: 500 });
  const msgs = branch(conv([u1, msg('assistant', { text: 'ok' }), u2]));
  assert.equal(findAnchor(msgs, { userId: u1.id }), 0);
  assert.equal(findAnchor(msgs, { prompt: 'another prompt that is long enough' }), 2);
  assert.equal(findAnchor(msgs, { prompt: 'reworded by chatgpt', since: 450 }), 2);
  assert.equal(findAnchor(msgs, { prompt: 'reworded by chatgpt', since: 1000 }), -1);
  assert.equal(findAnchor(msgs, { prompt: 'hello world prompt number one', afterId: u1.id }), -1);
});

test('system error in the reply is reported', () => {
  const u = msg('user', { text: 'x prompt' });
  const a = analyze(conv([u, msg('assistant', { content: { content_type: 'system_error', text: 'Network error' } })]), { userId: u.id });
  assert.equal(a.error, 'Network error');
});

test('text reply streaming then final', () => {
  const u = msg('user', { text: 'tell me' });
  const streaming = analyze(conv([u, msg('assistant', { text: 'Hel', status: 'in_progress', end_turn: null })]), { userId: u.id });
  assert.equal(streaming.final, false);
  assert.equal(streaming.inProgress, true);
  const done = analyze(conv([u, msg('assistant', { text: 'Hello' })]), { userId: u.id });
  assert.equal(done.final, true);
  assert.equal(done.text, 'Hello');
});
