// A stand-in for chatgpt.com, installed with Playwright routing (tests/e2e/run.mjs).
// Pages (/, /c/<id>) are tests/fake/chatgpt.html. The backend follows the real one's shape:
//   POST /backend-api/f/conversation      reply stream (text/event-stream, "v1" delta format)
//   GET  /backend-api/conversation/<id>   { mapping, current_node } (needs the bearer token)
//   GET  /api/auth/session                { accessToken }
//   GET  /backend-api/files/download/<id> { download_url }, then the PNG itself
// Tags in a prompt pick what happens (see reply()). A prompt mentioning "image" gets an image.
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const TOKEN = 'test-token';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const NUDGE = 'Yes, please generate the image now, exactly as described.';
const TOOL = 't2uay3k.sj1i4kz';

function crc32(buf) {
  let crc = 0xffffffff;
  for (const b of buf) {
    let c = (crc ^ b) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

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
  ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x++) row.set([r, g, b], 1 + x * 3);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const tag = (p, name) => {
  const m = new RegExp(`\\[${name}(?::(\\d+))?\\]`, 'i').exec(p);
  return m ? { n: Number(m[1] || 0) } : null;
};

export class FakeChatGPT {
  constructor({ thinkMs = 800 } = {}) {
    this.html = readFileSync(new URL('./chatgpt.html', import.meta.url), 'utf8');
    this.thinkMs = thinkMs;
    this.convs = new Map();
    this.sent = []; // every prompt the backend received, in order: { text, convId, files }
    this.seq = 0;
    this.jsonOff = false;
    this.down = false;
    this.once = new Set(); // tags that already fired once
  }

  id() {
    this.seq++;
    return `${this.seq.toString(16).padStart(8, '0')}-0000-4000-8000-${Date.now().toString(16).padStart(12, '0').slice(-12)}`;
  }

  async install(context) {
    await context.route(/^https:\/\/(chatgpt\.com|chat\.openai\.com)\/.*/, (route) => this.handle(route).catch(() => {}));
  }

  async handle(route) {
    const req = route.request();
    // The internet is down but the browser still thinks it's online (the common real case).
    if (this.down) return route.abort('internetdisconnected');
    const url = new URL(req.url());
    const path = url.pathname;
    if (path === '/api/auth/session') return route.fulfill({ json: { accessToken: TOKEN } });
    if (path.startsWith('/backend-api/')) {
      if (path === '/backend-api/f/conversation' && req.method() === 'POST') return this.converse(route, req);
      // Image files are served by signed URL (no bearer token), so <img> tags load them too.
      if (path === '/backend-api/estuary/content') {
        const id = url.searchParams.get('id') || '';
        const color = id.includes('part') ? [200, 200, 200] : [(id.length * 37) % 255, 120, 200];
        return route.fulfill({ status: 200, contentType: 'image/png', body: solidPng(id.includes('part') ? 64 : 256, color) });
      }
      const auth = (await req.allHeaders()).authorization;
      if (auth !== `Bearer ${TOKEN}`) return route.fulfill({ status: 401, json: { detail: 'Unauthorized' } });
      let m = /^\/backend-api\/conversation\/([\w-]+)$/.exec(path);
      if (m) {
        if (this.jsonOff) return route.fulfill({ status: 404, json: { detail: 'Not found' } });
        const conv = this.convs.get(m[1]);
        return conv ? route.fulfill({ json: this.toJson(conv) }) : route.fulfill({ status: 404, json: { detail: 'Conversation not found' } });
      }
      m = /^\/backend-api\/files\/download\/([\w-]+)$/.exec(path);
      if (m) return route.fulfill({ json: { status: 'success', download_url: `https://chatgpt.com/backend-api/estuary/content?id=${m[1]}&sig=x` } });
      return route.fulfill({ status: 404, json: { detail: 'unknown' } });
    }
    return route.fulfill({ status: 200, contentType: 'text/html', body: this.html });
  }

  message(role, text, extra = {}) {
    return {
      id: this.id(), author: { role, name: null }, create_time: Date.now() / 1000,
      content: { content_type: 'text', parts: [text] }, status: 'finished_successfully', end_turn: role === 'assistant' ? true : null,
      recipient: 'all', metadata: {}, ...extra,
    };
  }

  imageMessage(pointer, { partial = false } = {}) {
    return this.message('tool', '', {
      author: { role: 'tool', name: TOOL },
      status: partial ? 'in_progress' : 'finished_successfully',
      metadata: { image_gen_async: true, async_task_id: 'task' },
      content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: pointer, width: 256, height: 256, metadata: partial ? { generation: { partial: true } } : { generation: { gen_id: 'g' } } }] },
    });
  }

  /** What happens for a prompt. */
  reply(prompt, conv) {
    const p = prompt.toLowerCase();
    const prev = conv.messages[conv.messages.length - 1];
    if (prompt === NUDGE && prev?.author.role === 'assistant' && /landscape or portrait/i.test(prev.content.parts?.[0] || '')) return { image: 'sync' };
    if (tag(p, 'ratelimit') && !this.once.has(prompt)) {
      this.once.add(prompt);
      return { http: 429, detail: "You've reached our limit of messages per hour. Please try again later." };
    }
    if (tag(p, 'toolong') && conv.messages.length > 0) return { error: 'The conversation is too long, please start a new chat.' };
    if (tag(p, 'fail')) return { error: 'Something went wrong while generating the response.' };
    // The image task dies: its message stays "in progress" forever and the page shows an error.
    // Only the first time; sent again, it works.
    if (tag(p, 'stuck') && !this.once.has(`stuck:${prompt}`)) {
      this.once.add(`stuck:${prompt}`);
      return { image: 'stuck' };
    }
    if (tag(p, 'refuse')) return { text: 'I can’t create that image because the request violates our content policies.' };
    if (tag(p, 'ask')) return { text: 'Sure! Would you like it in landscape or portrait?' };
    const isImage = /image|aspect ratio/.test(p);
    if (!isImage) {
      const slow = tag(p, 'slowtext');
      return slow ? { handoff: true, text: `Echo: ${prompt}`, delay: slow.n * 1000 } : { text: `Echo: ${prompt}` };
    }
    for (const kind of ['async', 'silent', 'dark', 'partial']) {
      const t = tag(p, kind);
      if (t) return { image: kind, after: t.n * 1000 };
    }
    if (tag(p, 'two')) return { image: 'two' };
    return { image: 'sync' };
  }

  async converse(route, req) {
    const body = JSON.parse(req.postData() || '{}');
    const userMsg = body.messages?.[0];
    const prompt = (userMsg?.content?.parts || []).filter((x) => typeof x === 'string').join('\n');
    const files = (userMsg?.metadata?.attachments || []).map((a) => a.name);
    let conv = this.convs.get(body.conversation_id);
    if (!conv) {
      conv = { id: this.id(), messages: [] };
      this.convs.set(conv.id, conv);
    }
    const r = this.reply(prompt, conv);
    this.sent.push({ text: prompt, convId: conv.id, files });
    if (r.http) return route.fulfill({ status: r.http, json: { detail: r.detail } });
    const user = { ...this.message('user', prompt), id: userMsg?.id || this.id() };
    conv.messages.push(user);
    const head = [
      'event: delta_encoding\ndata: "v1"\n\n',
      `event: delta\ndata: ${JSON.stringify({ p: '', o: 'add', v: { message: user, conversation_id: conv.id, error: null }, c: 0 })}\n\n`,
    ];
    await sleep(this.thinkMs);
    if (r.error) return this.stream(route, [...head, `data: ${JSON.stringify({ message: null, conversation_id: conv.id, error: r.error })}\n\n`, 'data: [DONE]\n\n']);
    const events = [...head];
    if (r.image) {
      const call = { ...this.message('assistant', ''), recipient: TOOL, end_turn: false, content: { content_type: 'code', text: '{}' } };
      conv.messages.push(call);
      const pointer = () => `sediment://file_${this.id().slice(0, 8)}`;
      if (r.image === 'sync' || r.image === 'two') {
        const imgs = r.image === 'two' ? [this.imageMessage(pointer()), this.imageMessage(pointer())] : [this.imageMessage(pointer())];
        conv.messages.push(...imgs);
        for (const img of imgs) events.push(`event: delta\ndata: ${JSON.stringify({ v: { message: img, conversation_id: conv.id, error: null }, c: 1 })}\n\n`);
      } else {
        // Drawn after the reply stream has closed.
        let pending;
        if (r.image === 'async') pending = this.message('tool', 'Processing image', { author: { role: 'tool', name: TOOL }, status: 'in_progress', metadata: { image_gen_async: true, async_task_id: 'task' } });
        else if (r.image === 'silent') pending = this.message('tool', 'Processing image. Lots of people are creating images right now, so this might take a bit.', { author: { role: 'tool', name: TOOL }, metadata: { image_gen_async: true, async_task_id: 'task' } });
        else if (r.image === 'stuck') pending = this.message('tool', '', { author: { role: 'tool', name: TOOL }, status: 'in_progress', metadata: { image_gen_async: true, async_task_id: 'task', page_error: 'Something went wrong while generating the image.' } });
        else if (r.image === 'dark') pending = this.message('tool', '', { author: { role: 'tool', name: TOOL }, metadata: { image_gen_async: true, async_task_id: 'task', hide: true } });
        else pending = this.imageMessage(`sediment://file_part${this.seq}`, { partial: true });
        conv.messages.push(pending);
        events.push(`event: delta\ndata: ${JSON.stringify({ v: { message: pending, conversation_id: conv.id, error: null }, c: 1 })}\n\n`);
        if (r.image !== 'stuck') {
          setTimeout(() => {
            const done = this.imageMessage(pointer());
            Object.assign(pending, done, { id: pending.id });
          }, r.after);
        }
      }
    } else if (r.handoff) {
      const bot = this.message('assistant', '', { status: 'in_progress', end_turn: null });
      conv.messages.push(bot);
      setTimeout(() => Object.assign(bot, { status: 'finished_successfully', end_turn: true, content: { content_type: 'text', parts: [r.text] } }), r.delay);
      events.push(`data: ${JSON.stringify({ type: 'stream_handoff', conversation_id: conv.id })}\n\n`);
    } else {
      const bot = this.message('assistant', r.text);
      conv.messages.push(bot);
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
    return { conversation_id: conv.id, title: 'Fake', current_node: parent, mapping };
  }

  /** Prompts received, without the image nudges. */
  prompts() {
    return this.sent.filter((s) => s.text !== NUDGE).map((s) => s.text);
  }
}
