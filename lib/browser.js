// The extension API namespace for the current browser: `browser` in Firefox (promise based),
// `chrome` in Chromium browsers (Chrome, Edge, Brave, Opera, Vivaldi, Arc…).
// Undefined outside an extension (unit tests), so only touch it inside functions.
export const api = globalThis.browser?.runtime?.id ? globalThis.browser : globalThis.chrome;

/** Short name of the browser, for diagnostics and the browser-specific tips in the panel. */
export function browserName(ua = globalThis.navigator?.userAgent || '') {
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\/|Opera/.test(ua)) return 'Opera';
  if (/Vivaldi/.test(ua)) return 'Vivaldi';
  if (globalThis.navigator?.brave) return 'Brave';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'Unknown';
}
