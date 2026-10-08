// Runtime-switchable UI translations, read from the extension's _locales/<lang>/messages.json.
// (i18n.getMessage always follows the browser language; this lets users pick one in the panel.)
import { api } from '../lib/browser.js';

export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'vi', label: 'Tiếng Việt' },
  { code: 'zh_CN', label: '中文' },
  { code: 'ko', label: '한국어' },
  { code: 'ja', label: '日本語' },
  { code: 'es', label: 'Español' },
];

let fallback = {};
let messages = {};

async function load(code) {
  const res = await fetch(api.runtime.getURL(`_locales/${code}/messages.json`));
  const json = await res.json();
  return Object.fromEntries(Object.entries(json).map(([k, v]) => [k, v.message]));
}

/** Best match for the browser UI language, e.g. "zh-CN" -> "zh_CN", "es-419" -> "es". */
export function detectLanguage() {
  const ui = (api.i18n?.getUILanguage?.() || navigator.language || 'en').replace('-', '_');
  const exact = LANGUAGES.find((l) => l.code.toLowerCase() === ui.toLowerCase());
  if (exact) return exact.code;
  const base = ui.split('_')[0].toLowerCase();
  return (LANGUAGES.find((l) => l.code.split('_')[0] === base) || LANGUAGES[0]).code;
}

export async function setLanguage(code) {
  if (!Object.keys(fallback).length) fallback = await load('en');
  messages = code === 'en' ? fallback : await load(code).catch(() => fallback);
  document.documentElement.lang = code.replace('_', '-');
  apply(document);
}

/** Translate a key; {0}, {1}… are replaced by params. */
export function t(key, params = []) {
  const template = messages[key] ?? fallback[key] ?? key;
  return template.replace(/\{(\d+)\}/g, (_, i) => (params[i] ?? ''));
}

/** Fill data-i18n (text), data-i18n-placeholder and data-i18n-title attributes. */
export function apply(root) {
  root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
}
