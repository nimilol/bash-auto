// Reads a ChatGPT conversation as returned by GET /backend-api/conversation/<id> and answers:
// is the reply to our prompt finished, what is its text, and which images did it produce?
// Pure functions (no DOM, no extension APIs): loaded before agent.js and by the unit tests.
(() => {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/[‘’ʼ]/g, "'");
  const IMAGE_TOOL = /t2uay3k|image_gen|imagegen|dalle|image\.create/i;
  const TEXT_TYPES = new Set(['text', 'multimodal_text']);

  /** The messages on the conversation's current branch, oldest first. */
  function branch(conv) {
    const mapping = conv?.mapping || {};
    let id = conv?.current_node;
    if (!id || !mapping[id]) {
      // No current node: take the newest leaf.
      const leaves = Object.values(mapping).filter((n) => !n.children?.length && n.message);
      leaves.sort((a, b) => (a.message.create_time || 0) - (b.message.create_time || 0));
      id = leaves[leaves.length - 1]?.id;
    }
    const out = [];
    const seen = new Set();
    while (id && mapping[id] && !seen.has(id)) {
      seen.add(id);
      if (mapping[id].message) out.push(mapping[id].message);
      id = mapping[id].parent;
    }
    return out.reverse();
  }

  const roleOf = (m) => m?.author?.role || '';
  const stringParts = (m) => (m?.content?.parts || []).filter((p) => typeof p === 'string');
  const hidden = (m) => !!m?.metadata?.is_visually_hidden_from_conversation;

  function pointersOf(m) {
    return (m?.content?.parts || [])
      .filter((p) => p && typeof p === 'object' && /image_asset_pointer/.test(p.content_type || '') && p.asset_pointer)
      .map((p) => p.asset_pointer);
  }

  /** Text a person sees from this message (assistant replies only, no reasoning or tool calls). */
  function visibleText(m) {
    if (roleOf(m) !== 'assistant' || hidden(m)) return '';
    if (m.recipient && m.recipient !== 'all') return '';
    if (!TEXT_TYPES.has(m.content?.content_type)) return '';
    return stringParts(m).join('\n').trim();
  }

  function isImageTask(m) {
    const meta = m?.metadata || {};
    return !!(meta.image_gen_async || meta.async_task_id || meta.image_gen_task_id
      || IMAGE_TOOL.test(String(m?.author?.name || '')) || IMAGE_TOOL.test(String(m?.recipient || '')));
  }

  /**
   * Index of our prompt on the branch: by message id, else the latest user message showing it,
   * else (when `since`, in epoch seconds, is given) the latest user message, if it was sent since then.
   */
  function findAnchor(msgs, { userId, prompt, since } = {}) {
    if (userId) {
      const i = msgs.findIndex((m) => m.id === userId);
      if (i !== -1) return i;
    }
    const want = norm(prompt);
    if (!want) return -1;
    const head = want.slice(0, 200);
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (roleOf(msgs[i]) !== 'user') continue;
      const text = norm(stringParts(msgs[i]).join('\n'));
      if (text === want || (head.length >= 20 && text.startsWith(head)) || (text && want.startsWith(text) && text.length >= 20)) return i;
    }
    if (since) {
      // Clocks differ between the browser and the server: allow two minutes either way.
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (roleOf(msgs[i]) !== 'user') continue;
        return (msgs[i].create_time || 0) >= since - 120 ? i : -1;
      }
    }
    return -1;
  }

  const finishedStatus = (m) => !m.status || /finished|complete|success/i.test(m.status);

  /** Is ChatGPT done after this message (the last one on the branch)? */
  function isFinal(m) {
    if (!m || !finishedStatus(m)) return false;
    const role = roleOf(m);
    if (role === 'assistant') {
      if (m.end_turn === false) return false;
      if (m.recipient && m.recipient !== 'all') return false;
      return m.end_turn === true || TEXT_TYPES.has(m.content?.content_type);
    }
    if (role === 'tool') return pointersOf(m).length > 0;
    return false;
  }

  /**
   * Where the reply to our prompt stands.
   * opts: { userId, prompt }
   * Returns { anchor:false } when the prompt isn't in the conversation (yet), else
   * { anchor:true, anchorId, final, text, lastText, images:[pointer], imageTask, imagePending, lastRole, lastStatus, signature }.
   */
  function analyze(conv, opts) {
    const msgs = branch(conv);
    const at = findAnchor(msgs, opts);
    if (at === -1) return { anchor: false, messages: msgs.length };
    const tail = msgs.slice(at + 1).filter((m) => roleOf(m) !== 'system');
    const texts = tail.map(visibleText).filter(Boolean);
    const images = [...new Set(tail.flatMap(pointersOf))];
    const imageTask = tail.some(isImageTask);
    const last = tail[tail.length - 1];
    const lastAssistant = [...tail].reverse().find((m) => visibleText(m));
    return {
      anchor: true,
      anchorId: msgs[at].id || '',
      // A finished tool message after the image (e.g. "returned 1 images") also ends the turn.
      final: isFinal(last) || (images.length > 0 && roleOf(last) === 'tool' && finishedStatus(last)),
      text: texts.join('\n\n'),
      lastText: lastAssistant ? visibleText(lastAssistant) : '',
      images,
      imageTask,
      imagePending: imageTask && !images.length,
      lastRole: roleOf(last),
      lastStatus: last?.status || '',
      signature: `${tail.length}|${texts.join('').length}|${images.join(',')}|${last?.status || ''}|${last?.end_turn}`,
    };
  }

  globalThis.CGA_CONV = { branch, analyze, findAnchor, isFinal, visibleText, pointersOf };
})();
