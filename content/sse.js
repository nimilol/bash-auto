// Reads ChatGPT's reply stream (server-sent events from POST /backend-api/(f/)conversation).
// Loaded into the page's own world before page-hook.js, and by the unit tests.
// Only what the extension needs is pulled out: the conversation id, error events, image-task
// markers and event types. Anything else in the stream is ignored, so format changes don't break it.
(() => {
  const IMAGE_TOOL = /t2uay3k|image_gen|imagegen|dalle|image\.create|image_generation/i;

  /** Calls onEvent({ event, data }) for every complete SSE block it is fed. */
  function createParser(onEvent) {
    let buffer = '';
    const flush = (block) => {
      let event = 'message';
      const data = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length) onEvent({ event, data: data.join('\n') });
    };
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

  function newSummary() {
    return { convId: '', types: [], error: '', imageTask: false, imagePointers: 0, messages: 0, done: false, events: 0, tooLong: false };
  }

  function errorText(err) {
    if (!err) return '';
    if (typeof err === 'string') return err.slice(0, 300);
    return String(err.message || err.detail || err.code || JSON.stringify(err)).slice(0, 300);
  }

  function inspectMessage(sum, msg) {
    sum.messages++;
    const meta = msg.metadata || {};
    if (meta.image_gen_async || meta.async_task_id || meta.image_gen_task_id
      || IMAGE_TOOL.test(String(msg.author?.name || '')) || IMAGE_TOOL.test(String(msg.recipient || ''))) sum.imageTask = true;
    for (const part of msg.content?.parts || []) {
      if (part && typeof part === 'object' && /image_asset_pointer/.test(part.content_type || '')) sum.imagePointers++;
    }
  }

  /** Walks a parsed event (a few levels deep, any layout). */
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
    if (value.author && typeof value.author === 'object' && value.content) inspectMessage(sum, value);
    for (const key of ['message', 'v', 'data', 'messages', 'payload']) {
      if (value[key] && typeof value[key] === 'object') walk(sum, value[key], depth + 1);
    }
  }

  /** Updates the summary with one SSE event. */
  function summarize(sum, { event, data }) {
    sum.events++;
    if (event && event !== 'message' && event !== 'delta' && sum.types.length < 40 && !sum.types.includes(`event:${event}`)) sum.types.push(`event:${event}`);
    const text = String(data || '').trim();
    if (text === '[DONE]') {
      sum.done = true;
      return sum;
    }
    if (text && (text[0] === '{' || text[0] === '[')) {
      try { walk(sum, JSON.parse(text)); } catch { /* not JSON */ }
    }
    if (sum.error && isTooLong(sum.error)) sum.tooLong = true;
    return sum;
  }

  /** What a prompt request carries: the user message id and text, the conversation id. */
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

  /** The conversation has hit its length limit. */
  function isTooLong(text) {
    return /conversation (is )?too long|maximum (conversation|context) length|reached the (maximum|max) length|start a new chat/i.test(String(text || ''));
  }

  /** A fetch failure caused by the connection rather than by ChatGPT. */
  function isNetworkError(text) {
    return /failed to fetch|networkerror|network error|load failed|err_internet|err_network|net::|connection|offline|timed? ?out/i.test(String(text || ''));
  }

  globalThis.CGA_SSE = { createParser, newSummary, summarize, readRequestBody, isTooLong, isNetworkError, IMAGE_TOOL };
})();
