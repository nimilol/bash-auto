// Reads a ChatGPT conversation as returned by GET /backend-api/conversation/<id> and reports where
// the reply to one prompt stands: its text, the images it produced, and whether ChatGPT is still
// working on it. Pure functions (no DOM, no extension APIs): used by agent.js and the unit tests.
(() => {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/[‘’ʼ]/g, "'");
  const IMAGE_TOOL = /t2uay3k|image_gen|imagegen|dalle|image\.create|image_generation/i;
  const TEXT_TYPES = new Set(['text', 'multimodal_text']);
  const IN_PROGRESS = /in_progress|streaming|pending|running|queued/i;

  /** Messages on the conversation's current branch, oldest first. */
  function branch(conv) {
    const mapping = conv?.mapping || {};
    let id = conv?.current_node;
    if (!id || !mapping[id]) {
      const leaves = Object.values(mapping).filter((n) => n && !n.children?.length && n.message);
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

  /** A partial preview of an image that is still being drawn. */
  function isPartial(part) {
    const md = part?.metadata || {};
    return !!(md.partial || md.is_partial || md.generation?.partial || md.dalle?.partial || part?.partial);
  }

  function imageParts(m) {
    return (m?.content?.parts || []).filter((p) => p && typeof p === 'object' && /image_asset_pointer/.test(p.content_type || '') && p.asset_pointer);
  }

  /** Finished images in a message, as asset pointers. */
  function pointersOf(m) {
    return imageParts(m).filter((p) => !isPartial(p)).map((p) => p.asset_pointer);
  }

  /** Every finished image in the conversation (to ignore older images in a long chat). */
  function allPointers(conv) {
    return [...new Set(branch(conv).filter((m) => roleOf(m) !== 'user').flatMap(pointersOf))];
  }

  /** Text a person sees in this message (assistant replies only: no reasoning, no tool calls). */
  function visibleText(m) {
    if (roleOf(m) !== 'assistant' || hidden(m)) return '';
    if (m.recipient && m.recipient !== 'all') return '';
    if (!TEXT_TYPES.has(m.content?.content_type)) return '';
    return stringParts(m).join('\n').trim();
  }

  function isImageTask(m) {
    const md = m?.metadata || {};
    return !!(md.image_gen_async || md.async_task_id || md.image_gen_task_id || md.image_gen_title
      || IMAGE_TOOL.test(String(m?.author?.name || '')) || IMAGE_TOOL.test(String(m?.recipient || '')));
  }

  function errorOf(m) {
    if (m?.content?.content_type === 'system_error') return String(m.content.text || stringParts(m).join(' ') || 'error');
    const md = m?.metadata || {};
    if (md.error_message || md.error_type) return String(md.error_message || md.error_type);
    if (/error/i.test(String(m?.status || ''))) return String(m.status);
    return '';
  }

  /**
   * Index of our prompt on the branch: by message id; else the latest user message showing it
   * (only after `afterId`, the previous prompt's message, so a long chat with repeated prompts
   * never matches an older one); else, with `since` (epoch seconds), the latest user message if
   * it was sent since then.
   */
  function findAnchor(msgs, { userId, prompt, afterId, since } = {}) {
    if (userId) {
      const i = msgs.findIndex((m) => m.id === userId);
      if (i !== -1) return i;
    }
    let from = 0;
    if (afterId) {
      const a = msgs.findIndex((m) => m.id === afterId);
      if (a !== -1) from = a + 1;
    }
    const want = norm(prompt);
    if (want) {
      const head = want.slice(0, 200);
      for (let i = msgs.length - 1; i >= from; i--) {
        if (roleOf(msgs[i]) !== 'user') continue;
        const text = norm(stringParts(msgs[i]).join('\n'));
        if (!text) continue;
        if (text === want || (head.length >= 20 && text.startsWith(head)) || (text.length >= 20 && want.startsWith(text))) return i;
      }
    }
    if (since) {
      for (let i = msgs.length - 1; i >= from; i--) {
        if (roleOf(msgs[i]) !== 'user') continue;
        // Browser and server clocks differ: allow two minutes.
        return (msgs[i].create_time || 0) >= since - 120 ? i : -1;
      }
    }
    return -1;
  }

  const finished = (m) => !m?.status || /finished|complete|success/i.test(m.status);

  /**
   * Where the reply to our prompt stands.
   * opts: { userId, prompt, afterId, since, baseline: Set|Array of pointers to ignore, followUps: [text] }
   */
  function analyze(conv, opts = {}) {
    const msgs = branch(conv);
    const at = findAnchor(msgs, opts);
    if (at === -1) return { anchor: false, messages: msgs.length };
    const baseline = new Set(opts.baseline || []);
    const followUps = new Set((opts.followUps || []).map(norm));
    let tail = msgs.slice(at + 1).filter((m) => roleOf(m) !== 'system');
    // Our own follow-up ("please generate the image now") belongs to this prompt; any other user
    // message after ours means someone else wrote in the chat: only look up to it.
    const otherUser = tail.findIndex((m) => roleOf(m) === 'user' && !followUps.has(norm(stringParts(m).join('\n'))));
    const laterPrompt = otherUser !== -1;
    if (laterPrompt) tail = tail.slice(0, otherUser);
    const texts = tail.map(visibleText).filter(Boolean);
    const images = [...new Set(tail.flatMap(pointersOf))].filter((p) => !baseline.has(p));
    const partials = tail.flatMap(imageParts).filter(isPartial).length;
    const imageTask = tail.some(isImageTask);
    const inProgress = tail.some((m) => IN_PROGRESS.test(String(m.status || '')));
    const last = tail[tail.length - 1];
    const lastRole = roleOf(last);
    const lastAssistant = [...tail].reverse().find((m) => visibleText(m));
    const errors = tail.map(errorOf).filter(Boolean);
    // The turn is still open: no reply yet, ChatGPT is calling a tool, or it said it isn't done.
    const turnOpen = !last || lastRole === 'user'
      || (lastRole === 'assistant' && ((last.recipient && last.recipient !== 'all') || last.end_turn === false));
    let final = false;
    if (last && finished(last) && !inProgress) {
      if (lastRole === 'assistant') final = !turnOpen && (last.end_turn === true || TEXT_TYPES.has(last.content?.content_type));
      else if (lastRole === 'tool') final = pointersOf(last).length > 0;
    }
    return {
      anchor: true,
      anchorId: msgs[at].id || '',
      final,
      text: texts.join('\n\n'),
      lastText: lastAssistant ? visibleText(lastAssistant) : '',
      images,
      partials,
      imageTask,
      imagePending: imageTask && !images.length,
      inProgress,
      turnOpen,
      laterPrompt,
      error: errors[errors.length - 1] || '',
      lastRole,
      lastStatus: last?.status || '',
      signature: `${tail.length}|${texts.join('').length}|${images.join(',')}|${partials}|${tail.map((m) => m.status || '').join(',')}|${last?.end_turn}`,
    };
  }

  globalThis.CGA_CONV = { branch, analyze, findAnchor, allPointers, pointersOf, visibleText, isPartial };
})();
