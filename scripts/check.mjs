// Static checks: the manifest points at files that exist, its messages are defined, every script
// parses, and every element the panel script looks up exists in the panel page.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const read = (p) => readFileSync(join(root, p), 'utf8');
const need = (p, why) => { if (!existsSync(join(root, p))) problems.push(`missing ${p} (${why})`); };

const manifest = JSON.parse(read('manifest.json'));
if (manifest.manifest_version !== 3) problems.push('manifest_version must be 3');
need(manifest.background.service_worker, 'background.service_worker');
need(manifest.side_panel.default_path, 'side_panel');
Object.values(manifest.icons).forEach((p) => need(p, 'icons'));
Object.values(manifest.action.default_icon).forEach((p) => need(p, 'action icon'));
manifest.content_scripts.forEach((cs) => cs.js.forEach((p) => need(p, 'content_scripts')));
need('offscreen/offscreen.html', 'offscreen document');

const messages = JSON.parse(read(`_locales/${manifest.default_locale}/messages.json`));
for (const m of JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)) if (!messages[m[1]]) problems.push(`locale key ${m[1]} not defined`);

// Scripts the service worker injects must be the manifest's content scripts.
const sw = read('background/service-worker.js');
const injected = [...sw.matchAll(/'(content\/[\w.-]+\.js)'/g)].map((m) => m[1]);
const declared = manifest.content_scripts.flatMap((cs) => cs.js);
if (JSON.stringify(injected) !== JSON.stringify(declared)) problems.push(`injected scripts ${injected} differ from the manifest's ${declared}`);

// Every JS file parses.
const walk = (dir) => readdirSync(join(root, dir)).flatMap((f) => {
  const p = join(dir, f);
  return statSync(join(root, p)).isDirectory() ? walk(p) : [p];
});
for (const file of ['lib', 'content', 'background', 'panel', 'offscreen'].flatMap(walk).filter((f) => f.endsWith('.js'))) {
  try {
    execFileSync(process.execPath, ['--check', join(root, file)], { stdio: 'pipe' });
  } catch (e) {
    problems.push(`${file}: ${e.stderr.toString().split('\n').slice(0, 4).join(' ')}`);
  }
}

// Panel: every #id used by panel.js exists in index.html.
const html = read('panel/index.html');
const ids = new Set([...html.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
for (const m of read('panel/panel.js').matchAll(/\$\('#([\w-]+)/g)) if (!ids.has(m[1])) problems.push(`panel.js uses #${m[1]}, not in index.html`);
for (const m of html.matchAll(/data-setting="(\w+)"/g)) {
  if (!read('lib/utils.js').includes(`${m[1]}:`)) problems.push(`setting ${m[1]} has no default in lib/utils.js`);
}

if (problems.length) {
  console.error(problems.map((p) => `✗ ${p}`).join('\n'));
  process.exit(1);
}
console.log(`✓ manifest, files, locales, ${injected.length} injected scripts, syntax and panel ids OK`);
