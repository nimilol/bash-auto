// A stand-in for chatgpt.com used by tests/e2e.mjs, installed with Playwright routing.
// Pages (/, /c/<id>) are tests/mock-chatgpt.html. The backend follows the real one's shape:
//   POST /backend-api/f/conversation      -> reply stream (text/event-stream, "v1" delta format),
//                                            delivered once the reply is generated (or at once,
//                                            handing off to the conversation, for "slow" prompts)
//   GET  /backend-api/conversation/<id>   -> { mapping, current_node } (needs the bearer token)
//   GET  /api/auth/session                -> { accessToken }
//   GET  /backend-api/files/download/<id> -> { download_url }, then the PNG itself
// Words in a prompt pick the scenario (see reply()).
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const TOKEN = 'test-token';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (const b of buf) {
    c = (crc ^ b) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A solid-color PNG. */
export function solidPng(size, [r, g, b]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x++) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const NUDGE = 'Yes, please generate the image now, exactly as described.';

export class FakeChatGPT {
  constructor({ html, thinkMs = 1200 } = {}) {
    this.html = html || readFileSync(new URL('./mock-chatgpt.html', import.meta.url), 'utf8');
    this.thinkMs = thinkMs;
    this.convs = new Map();
    this.sent = []; // every prompt the backend received, in order
    this.models = []; // ?model= of each request
    this.jsonOff = false; // conversation reads fail (forces the page-watching fallback)
    this.imageLinksOff = false; // file download links fail (images come from the page)
    this.seq = 0;
  }

  id(prefix) {
    return `${prefix}-${(++this.seq).toString(16).padStart(4, '0')}-${Date.now().toString(16)}`;
  }

  async install(context) {
    await context.route(/^https:\/\/(chatgpt\.com|chat\.openai\.com)\/.*/, (route) => this.handle(route).catch(() => {}));
  }

  async handle(route) {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    if (path === '/api/auth/session') return route.fulfill({ json: { accessToken: TOKEN } });
    if (path.startsWith('/backend-api/')) {
      const auth = (await req.allHeaders()).authorization;
      if (path === '/backend-api/f/conversation' && req.method() === 'POST') return this.converse(route, req);
      if (auth !== `Bearer ${TOKEN}`) return route.fulfill({ status: 401, json: { detail: 'Unauthorized' } });
      let m = /^\/backend-api\/conversation\/([\w-]+)$/.exec(path);
      if (m) {
        if (this.jsonOff) return route.fulfill({ status: 404, json: { detail: 'Not found' } });
        const conv = this.convs.get(m[1]);
        return conv ? route.fulfill({ json: this.toJson(conv) }) : route.fulfill({ status: 404, json: { detail: 'Conversation not found' } });
      }
      m = /^\/backend-api\/files\/download\/([\w-]+)$/.exec(path);
      if (m) {
        if (this.imageLinksOff) return route.fulfill({ status: 404, json: { detail: 'Not found' } });
        return route.fulfill({ json: { status: 'success', download_url: `https://chatgpt.com/backend-api/estuary/content?id=${m[1]}` } });
      }
      if (path === '/backend-api/estuary/content') {
        const color = url.searchParams.get('id').endsWith('b') ? [40, 80, 200] : [40, 170, 120];
        return route.fulfill({ status: 200, contentType: 'image/png', body: solidPng(256, color) });
      }
      return route.fulfill({ status: 404, json: { detail: 'unknown' } });
    }
    return route.fulfill({ status: 200, contentType: 'text/html', body: this.html });
  }

  /** What the backend answers to a prompt. */
  reply(prompt, files, conv) {
    const p = prompt.toLowerCase();
    const prev = conv.messages[conv.messages.length - 1];
    const askedBefore = prev?.author.role === 'assistant' && /landscape or portrait/i.test(prev.content.parts[0] || '');
    if (prompt === NUDGE && askedBefore) return { image: 'sync', text: '' };
    if (/rate limit/.test(p)) return { http: 429, detail: "You've reached our limit of messages per hour. Please try again later." };
    if (/please fail/.test(p)) return { error: 'Something went wrong while generating the response.' };
    if (/forbidden/.test(p)) return { text: 'I can’t create that image because the request violates our content policies.' };
    if (/ask first/.test(p)) return { text: 'Sure! Would you like it in landscape or portrait?' };
    const text = `Echo: ${prompt}${files.length ? ` [files: ${files.join(', ')}]` : ''}`;
    const delay = this.thinkMs;
    if (/async image/.test(p)) return { image: 'async', text: '', delay };
    if (/image/.test(p)) return { image: 'sync', text: '', delay };
    // Long replies: the stream hands off at once and the reply lands in the conversation later
    // (so the chat already has its /c/<id> address while ChatGPT is still working).
    if (/slow/.test(p)) return { handoff: true, text, delay: 7000 };
    if (/handoff/.test(p)) return { handoff: true, text, delay: 3000 };
    return { text, delay };
  }

  message(role, text, extra = {}) {
    return {
      id: this.id(role[0]), author: { role, name: null }, create_time: Date.now() / 1000,
      content: { content_type: 'text', parts: [text] }, status: 'finished_successfully', end_turn: role === 'assistant' ? true : null,
      recipient: 'all', metadata: {}, ...extra,
    };
  }

  imageMessage(pointer, pending) {
    const tool = { role: 'tool', name: 't2uay3k.sj1i4kz' };
    return pending
      ? this.message('tool', 'Processing image', { author: tool, status: 'in_progress', metadata: { image_gen_async: true, async_task_id: 'task' } })
      : {
        ...this.message('tool', '', { author: tool, metadata: { image_gen_async: true, async_task_id: 'task' } }),
        content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: pointer, width: 256, height: 256 }] },
      };
  }

  async converse(route, req) {
    const body = JSON.parse(req.postData() || '{}');
    const userMsg = body.messages?.[0];
    const prompt = (userMsg?.content?.parts || []).filter((x) => typeof x === 'string').join('\n');
    const files = (userMsg?.metadata?.attachments || []).map((a) => a.name);
    this.models.push(body.model || '');
    let conv = this.convs.get(body.conversation_id);
    if (!conv) {
      conv = { id: this.id('conv').replace(/^conv-/, '68e1aaaa-'), messages: [] };
      this.convs.set(conv.id, conv);
    }
    this.sent.push(prompt);
    const r = this.reply(prompt, files, conv);
    if (r.http) return route.fulfill({ status: r.http, json: { detail: r.detail } });
    const user = { ...this.message('user', prompt), id: userMsg?.id || this.id('u') };
    conv.messages.push(user);
    const head = [
      'event: delta_encoding\ndata: "v1"\n\n',
      `event: delta\ndata: ${JSON.stringify({ p: '', o: 'add', v: { message: user, conversation_id: conv.id, error: null }, c: 0 })}\n\n`,
    ];
    if (r.error) {
      await sleep(this.thinkMs);
      return this.stream(route, [...head, `data: ${JSON.stringify({ message: null, conversation_id: conv.id, error: r.error })}\n\n`, 'data: [DONE]\n\n']);
    }
    // While generating, the conversation shows the reply in progress.
    const bot = this.message('assistant', '', { status: 'in_progress', end_turn: null });
    conv.messages.push(bot);
    if (r.handoff) {
      // The stream closes at once; the reply lands in the conversation later.
      setTimeout(() => Object.assign(bot, { status: 'finished_successfully', end_turn: true, content: { content_type: 'text', parts: [r.text] } }), r.delay);
      return this.stream(route, [...head, `data: ${JSON.stringify({ type: 'stream_handoff', conversation_id: conv.id })}\n\n`, 'data: [DONE]\n\n']);
    }
    await sleep(r.delay ?? this.thinkMs);
    const events = [...head];
    if (r.image) {
      conv.messages.pop();
      const call = { ...this.message('assistant', ''), recipient: 't2uay3k.sj1i4kz', end_turn: false, content: { content_type: 'code', text: '{}' } };
      const pointer = `sediment://file_${this.seq}${prompt.includes('blue') ? 'b' : 'g'}`;
      const img = this.imageMessage(pointer, r.image === 'async');
      conv.messages.push(call, img);
      events.push(`event: delta\ndata: ${JSON.stringify({ v: { message: img, conversation_id: conv.id, error: null }, c: 1 })}\n\n`);
      if (r.image === 'async') {
        // Drawn after the stream has closed.
        setTimeout(() => Object.assign(img, this.imageMessage(pointer, false), { id: img.id }), 5000);
      }
    } else {
      Object.assign(bot, { status: 'finished_successfully', end_turn: true, content: { content_type: 'text', parts: [r.text] } });
      events.push(`event: delta\ndata: ${JSON.stringify({ p: '', o: 'add', v: { message: { ...bot, content: { content_type: 'text', parts: [''] } }, conversation_id: conv.id, error: null }, c: 1 })}\n\n`);
      events.push(`event: delta\ndata: ${JSON.stringify({ v: r.text })}\n\n`);
    }
    events.push(`data: ${JSON.stringify({ type: 'message_stream_complete', conversation_id: conv.id })}\n\n`, 'data: [DONE]\n\n');
    return this.stream(route, events);
  }

  stream(route, events) {
    return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' }, body: events.join('') });
  }

  toJson(conv) {
    const mapping = { root: { id: 'root', message: null, parent: null, children: [] } };
    let parent = 'root';
    for (const m of conv.messages) {
      mapping[m.id] = { id: m.id, message: structuredClone(m), parent, children: [] };
      mapping[parent].children.push(m.id);
      parent = m.id;
    }
    return { conversation_id: conv.id, title: 'Mock', current_node: parent, mapping };
  }

  /** Prompts sent, without the image nudges. */
  prompts() {
    return this.sent.filter((p) => p !== NUDGE);
  }
}
