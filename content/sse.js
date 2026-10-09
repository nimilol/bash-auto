// Reads ChatGPT's server-sent event stream (the reply to POST /backend-api/conversation).
// Loaded in the page's own world before net-hook.js; also loaded by the unit tests.
// It only pulls out what the extension needs: the conversation id, error events, image-task
// markers and event types. Everything else in the stream is ignored, so changes to its format
// don't break anything. Whether the stream has *ended* is the main completion signal (net-hook.js).
(() => {
  /** Calls onEvent({ event, data }) for each complete SSE block fed to it. */
  function createParser(onEvent) {
    let buffer = '';
    function flush(block) {
      let event = 'message';
      const data = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length) onEvent({ event, data: data.join('\n') });
    }
    return {
      feed(text) {
        buffer += text;
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop();
        blocks.forEach(flush);
      },
      end() {
        if (buffer.trim()) flush(buffer);
        buffer = '';
      },
    };
  }

  const IMAGE_TOOL = /t2uay3k|image_gen|imagegen|dalle|image\.create/i;

  function newSummary() {
    return { convId: '', types: [], error: '', imageTask: false, imagePointers: 0, messages: 0, done: false, events: 0 };
  }

  function errorText(err) {
    if (!err) return '';
    if (typeof err === 'string') return err;
    return String(err.message || err.detail || err.code || JSON.stringify(err)).slice(0, 300);
  }

  /** Looks at one message object from the stream. */
  function inspectMessage(sum, msg) {
    sum.messages++;
    const meta = msg.metadata || {};
    const name = String(msg.author?.name || '');
    if (meta.image_gen_async || meta.async_task_id || meta.image_gen_task_id || IMAGE_TOOL.test(name)
      || IMAGE_TOOL.test(String(msg.recipient || ''))) sum.imageTask = true;
    for (const part of msg.content?.parts || []) {
      if (part && typeof part === 'object' && /image_asset_pointer/.test(part.content_type || '')) sum.imagePointers++;
    }
  }

  /** Walks a parsed event (a few levels deep, any layout) and updates the summary. */
  function walk(sum, value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 5) return;
    if (Array.isArray(value)) {
      value.slice(0, 50).forEach((v) => walk(sum, v, depth + 1));
      return;
    }
    if (typeof value.conversation_id === 'string' && value.conversation_id) sum.convId = value.conversation_id;
    if (typeof value.type === 'string' && sum.types.length < 40 && !sum.types.includes(value.type)) sum.types.push(value.type);
    const err = value.error;
    if (value.type === 'error' || (typeof err === 'string' && err && depth <= 1) || (err && typeof err === 'object' && depth === 0)) {
      sum.error = errorText(err || value.message || value);
    }
    if (value.author && value.content && typeof value.author === 'object') inspectMessage(sum, value);
    for (const key of ['message', 'v', 'data', 'messages', 'payload']) {
      if (value[key] && typeof value[key] === 'object') walk(sum, value[key], depth + 1);
    }
  }

  /** Updates the summary with one SSE event. */
  function summarize(sum, { event, data }) {
    sum.events++;
    if (event && event !== 'message' && event !== 'delta' && sum.types.length < 40 && !sum.types.includes(`event:${event}`)) {
      sum.types.push(`event:${event}`);
    }
    const text = String(data || '').trim();
    if (text === '[DONE]') {
      sum.done = true;
      return sum;
    }
    if (!text || (text[0] !== '{' && text[0] !== '[')) return sum;
    try {
      walk(sum, JSON.parse(text));
    } catch { /* not JSON: ignore */ }
    return sum;
  }

  /** What the request body says: the user message id and text, and the conversation id. */
  function readRequestBody(body) {
    const out = { userId: '', userText: '', convId: '', action: '' };
    if (typeof body !== 'string' || !body) return out;
    let json;
    try { json = JSON.parse(body); } catch { return out; }
    out.convId = typeof json.conversation_id === 'string' ? json.conversation_id : '';
    out.action = String(json.action || '');
    const msgs = Array.isArray(json.messages) ? json.messages : [];
    const user = [...msgs].reverse().find((m) => m?.author?.role === 'user') || msgs[msgs.length - 1];
    if (user) {
      out.userId = String(user.id || '');
      out.userText = (user.content?.parts || []).filter((p) => typeof p === 'string').join('\n');
    }
    return out;
  }

  globalThis.CGA_SSE = { createParser, newSummary, summarize, readRequestBody };
})();
