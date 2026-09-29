// Static checks: manifest + locale JSON parse, every locale has the same keys as English,
// every i18n key used in the side panel exists, and every file the manifest references exists.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const errors = [];

const manifest = JSON.parse(read('manifest.json'));
const referenced = [
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon),
  manifest.side_panel.default_path,
  manifest.background.service_worker,
  ...manifest.content_scripts.flatMap((c) => c.js),
];
for (const f of referenced) if (!existsSync(join(root, f))) errors.push(`manifest references missing file ${f}`);

const locales = readdirSync(join(root, '_locales'));
const en = JSON.parse(read('_locales/en/messages.json'));
const enKeys = Object.keys(en).sort();
for (const code of locales) {
  const msgs = JSON.parse(read(`_locales/${code}/messages.json`));
  const keys = Object.keys(msgs).sort();
  const missing = enKeys.filter((k) => !msgs[k]);
  const extra = keys.filter((k) => !en[k]);
  if (missing.length) errors.push(`${code}: missing ${missing.join(', ')}`);
  if (extra.length) errors.push(`${code}: extra ${extra.join(', ')}`);
  for (const [k, v] of Object.entries(msgs)) {
    if (/\$/.test(v.message)) errors.push(`${code}.${k}: "$" must be escaped in Chrome messages`);
    const want = (en[k]?.message.match(/\{\d\}/g) || []).sort().join();
    const got = (v.message.match(/\{\d\}/g) || []).sort().join();
    if (want !== got) errors.push(`${code}.${k}: placeholders ${got} != ${want}`);
  }
}
for (const k of ['extName', 'extDescription']) if (!en[k]) errors.push(`manifest message ${k} missing`);
if (en.extDescription.message.length > 132) errors.push('extDescription longer than 132 chars');

const html = read('sidepanel/index.html');
const js = ['app.js', 'runner.js'].map((f) => read(`sidepanel/${f}`)).join('\n');
const used = new Set([
  ...[...html.matchAll(/data-i18n(?:-placeholder|-title)?="([^"]+)"/g)].map((m) => m[1]),
  ...[...js.matchAll(/\bt\('([A-Za-z_]+)'/g)].map((m) => m[1]),
  ...[...js.matchAll(/'(log[A-Z][A-Za-z]+)'/g)].map((m) => m[1]),
  ...['text', 'textToImage', 'imageToImage', 'ingredients'].map((m) => `modeHint_${m}`),
  ...['queued', 'running', 'completed', 'failed'].map((s) => `status_${s}`),
]);
for (const k of used) if (!en[k]) errors.push(`i18n key used but not defined: ${k}`);

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`ok: ${locales.length} locales, ${enKeys.length} keys, ${referenced.length} manifest files`);
