// The decision at the heart of the extension: given everything known about one prompt right now,
// is its reply finished, still coming, or failed? Pure (no DOM, no timers): agent.js gathers the
// signals and acts on the answer, and the unit tests drive it through every case.
//
// Rules for an image prompt:
//  - Done: at least one new image (from ChatGPT's data or the page), nothing still generating,
//    and the set of images unchanged for a few seconds.
//  - Never failed while anything shows ChatGPT is still working (open stream, a message in
//    progress, an image task without its image, a progress indicator or Stop button on the page).
//    Only a hard cap or a long stretch with no change at all ends that wait, and then the prompt
//    is "interrupted": the next attempt looks for the image before sending anything again.
//  - "No image" only after every signal has been quiet for the quiet window, and after one last
//    fresh look at the conversation and the page.
(() => {
  const REFUSALS = [
    'content policy', 'content policies', 'violates our', 'violate our', 'against our policies', 'usage policies',
    "i can't create", "i can't generate", "i can't make", "i can't help with", "i can't assist", "i can't produce",
    'i cannot create', 'i cannot generate', 'i cannot make', "i'm unable to create", "i'm unable to generate",
    "i'm not able to create", "i'm not able to generate", 'unable to generate that image', "wasn't able to generate",
    'not able to create', "can't be generated", 'i won’t be able to', "i won't be able to",
  ];
  // Text that says the image is on its way (so a reply without an image yet is not the end).
  const WORKING = /creating (the |your )?image|generating (the |your )?image|image is being|processing image|working on (it|the image|your image)|getting started|one moment|lots of people are creating/i;

  const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/[‘’ʼ]/g, "'");
  const refusalIn = (text) => {
    const t = flat(text);
    return t ? REFUSALS.find((p) => t.includes(flat(p))) || '' : '';
  };
  const asksQuestion = (text) => /[?？]\s*["”']?\s*$/.test(String(text || '').trim());

  const SETTLE_MS = 5000; // images unchanged this long with nothing generating: all images are in
  const STALE_INDICATOR_MS = 90000; // images present, but a "generating" marker hasn't changed in this long
  const LOST_MS = 90000; // the prompt never showed up in the chat
  const ERROR_SHOWN_MS = 20000; // an error shown on the page with nothing else happening
  const TEXT_SETTLE_MS = 1500;
  const PAGE_TEXT_SETTLE_MS = 2500;

  /**
   * job:     { expectImages, nudged, canNudge, sentAt, lastChange, imagesChangedAt, finalCheckDone,
   *            quietMs, capMs, staleMs }
   * signals: { now, online,
   *            stream: { open, ended, error, tooLong, aborted, network } | null,
   *            json: analysis from CGA_CONV.analyze | null, jsonNetworkFails,
   *            dom: { images, generating, stop, error, text, promptShown, actionBar } }
   * returns: { type: 'wait', status } | { type: 'collect', source } | { type: 'nudge' } | { type: 'finalCheck' }
   *          | { type: 'refused', error } | { type: 'network', error }
   *          | { type: 'error', kind: 'chatgpt'|'tooLong'|'lost'|'stale'|'cap'|'noImage', error }
   */
  function decide(job, signals) {
    const { now } = signals;
    const stream = signals.stream || {};
    const json = signals.json || null;
    const dom = signals.dom || {};

    if (signals.online === false) return { type: 'network', error: 'The browser is offline' };
    if (stream.ended && !stream.aborted && (stream.error || stream.status >= 400)) {
      if (stream.tooLong) return { type: 'error', kind: 'tooLong', error: `ChatGPT: ${stream.error}` };
      return { type: 'error', kind: 'chatgpt', error: `ChatGPT error: ${stream.error || `HTTP ${stream.status}`}` };
    }
    if ((signals.jsonNetworkFails || 0) >= 3) return { type: 'network', error: 'ChatGPT could not be reached' };
    if (stream.ended && stream.aborted && stream.network && !json) return { type: 'network', error: `The connection dropped: ${stream.error || 'network error'}` };

    const anchored = json ? json.anchor : !!dom.promptShown;
    const jsonImages = json?.anchor ? json.images.length : 0;
    const images = Math.max(jsonImages, dom.images || 0);
    const strong = !!(stream.open || json?.inProgress || dom.generating || dom.stop);
    const weak = !!(json?.anchor && (json.turnOpen || json.imagePending || json.partials > 0));
    const quiet = now - job.lastChange;
    const sinceSent = now - job.sentAt;
    const text = (json?.anchor ? json.text : '') || dom.text || '';
    const lastText = (json?.anchor ? json.lastText : '') || dom.text || '';
    const shownError = (json?.anchor && json.error) || dom.error || '';

    if (json?.anchor && json.error && /too long|maximum.*length/i.test(json.error)) {
      return { type: 'error', kind: 'tooLong', error: `ChatGPT: ${json.error}` };
    }
    // The reply shows an error ("Something went wrong", "Network error") and the page shows no
    // work going on: a message left "in progress" in ChatGPT's data doesn't hold the queue then.
    const pageActive = !!(stream.open || dom.generating || dom.stop);
    if (dom.replyError && !pageActive && !images && quiet >= ERROR_SHOWN_MS) {
      return { type: 'error', kind: 'chatgpt', error: `ChatGPT error: ${String(dom.replyError).slice(0, 200)}` };
    }

    if (job.expectImages) {
      if (images > 0) {
        const stable = now - (job.imagesChangedAt || job.lastChange) >= SETTLE_MS;
        if (!strong && !weak && stable) return { type: 'collect', source: jsonImages ? 'network' : 'page' };
        if (!strong && weak && quiet >= 60000) return { type: 'collect', source: jsonImages ? 'network' : 'page' };
        if (quiet >= STALE_INDICATOR_MS) return { type: 'collect', source: jsonImages ? 'network' : 'page' };
        return { type: 'wait', status: 'image' };
      }
      if (sinceSent >= job.capMs) {
        return { type: 'error', kind: 'cap', error: strong || weak ? 'ChatGPT was still generating when the image wait limit was reached' : 'No image before the image wait limit' };
      }
      if (strong || weak) {
        if (quiet >= job.staleMs) return { type: 'error', kind: 'stale', error: `No progress for ${Math.round(quiet / 60000)} min while ChatGPT showed it was working` };
        return { type: 'wait', status: strong || json?.imageTask ? 'image' : 'replying' };
      }
      // Nothing is generating and there is no image.
      if (shownError && quiet >= ERROR_SHOWN_MS) return { type: 'error', kind: 'chatgpt', error: `ChatGPT error: ${String(shownError).slice(0, 200)}` };
      if (!anchored) {
        if (sinceSent >= LOST_MS && quiet >= LOST_MS / 2) return { type: 'error', kind: 'lost', error: 'The prompt never reached the chat' };
        return { type: 'wait', status: 'sent' };
      }
      const refusal = refusalIn(text);
      if (refusal && quiet >= 3000) return { type: 'refused', error: `Refused by ChatGPT: "${refusal}"` };
      if (job.canNudge && !job.nudged && asksQuestion(lastText) && quiet >= 3000) return { type: 'nudge' };
      if (quiet < job.quietMs || (WORKING.test(lastText) && quiet < job.staleMs)) return { type: 'wait', status: 'image' };
      if (!job.finalCheckDone) return { type: 'finalCheck' };
      if (job.canNudge && !job.nudged && text) return { type: 'nudge' };
      return { type: 'error', kind: 'noImage', error: text ? 'ChatGPT answered without an image' : 'No image was generated' };
    }

    // Text prompt.
    if (sinceSent >= job.capMs) return { type: 'error', kind: 'cap', error: 'Timed out waiting for the reply' };
    if (strong || weak) {
      if (quiet >= job.staleMs) return { type: 'error', kind: 'stale', error: `No progress for ${Math.round(quiet / 60000)} min` };
      return { type: 'wait', status: 'replying' };
    }
    if (shownError && !text && quiet >= ERROR_SHOWN_MS) return { type: 'error', kind: 'chatgpt', error: `ChatGPT error: ${String(shownError).slice(0, 200)}` };
    if (!anchored) {
      if (sinceSent >= LOST_MS && quiet >= LOST_MS / 2) return { type: 'error', kind: 'lost', error: 'The prompt never reached the chat' };
      return { type: 'wait', status: 'sent' };
    }
    if (json?.anchor && json.final && json.text && quiet >= TEXT_SETTLE_MS) return { type: 'collect', source: 'network' };
    if (!json && dom.text && quiet >= PAGE_TEXT_SETTLE_MS && (dom.actionBar || quiet >= 15000)) return { type: 'collect', source: 'page' };
    if (json?.anchor && json.text && quiet >= 30000) return { type: 'collect', source: 'network' };
    if (quiet >= job.quietMs) return { type: 'error', kind: 'stale', error: 'ChatGPT stopped responding' };
    return { type: 'wait', status: 'replying' };
  }

  globalThis.CGA_DECIDE = { decide, refusalIn, asksQuestion, SETTLE_MS };
})();
