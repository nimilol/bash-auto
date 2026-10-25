// Turns data into blob: URLs for chrome.downloads (the service worker can't create them).
// Each URL is released two minutes later, after the download has read it.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen' || msg.type !== 'MAKE_BLOB_URL') return false;
  (async () => {
    const blob = msg.dataUrl ? await (await fetch(msg.dataUrl)).blob() : new Blob([msg.text ?? ''], { type: msg.mime || 'text/plain' });
    const url = URL.createObjectURL(blob);
    setTimeout(() => URL.revokeObjectURL(url), 120000);
    return { url };
  })().then(sendResponse, (e) => sendResponse({ error: String(e?.message || e) }));
  return true;
});
