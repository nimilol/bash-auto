// Packages the extension for each browser family:
//   dist/chromium/  Chrome, Edge, Brave, Opera, Vivaldi, Arc (same files as the repo root)
//   dist/firefox/   Firefox 128+ (sidebar instead of side panel, event-page background)
// plus dist/bash-auto-<browser>-<version>.zip for each when the `zip` command is available.
// Run: npm run build
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SHIPPED = ['manifest.json', 'background.js', 'content', 'sidepanel', 'lib', '_locales', 'icons'];
export const FIREFOX_ID = 'bash-auto@nimilol.github.io';

/** The Chromium manifest rewritten for Firefox. */
export function firefoxManifest(manifest) {
  const m = structuredClone(manifest);
  delete m.side_panel;
  delete m.minimum_chrome_version;
  m.permissions = m.permissions
    .filter((p) => p !== 'sidePanel')
    .map((p) => (p === 'contextMenus' ? 'menus' : p));
  m.background = { scripts: [manifest.background.service_worker] };
  m.sidebar_action = {
    default_panel: manifest.side_panel.default_path,
    default_title: manifest.action.default_title,
    default_icon: manifest.action.default_icon,
    open_at_install: false,
  };
  m.browser_specific_settings = {
    gecko: {
      id: FIREFOX_ID,
      strict_min_version: '128.0',
      data_collection_permissions: { required: ['none'] },
    },
  };
  return m;
}

function hasZip() {
  try {
    execFileSync('zip', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function build() {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  const dist = join(root, 'dist');
  rmSync(dist, { recursive: true, force: true });
  const zip = hasZip();
  const targets = { chromium: manifest, firefox: firefoxManifest(manifest) };
  for (const [name, m] of Object.entries(targets)) {
    const out = join(dist, name);
    mkdirSync(out, { recursive: true });
    for (const entry of SHIPPED) cpSync(join(root, entry), join(out, entry), { recursive: true });
    writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(m, null, 2)}\n`);
    let line = `built dist/${name}`;
    if (zip) {
      const file = `bash-auto-${name}-${m.version}.zip`;
      execFileSync('zip', ['-qr', join(dist, file), '.'], { cwd: out });
      line += ` + dist/${file}`;
    }
    console.log(line);
  }
  if (!zip) console.log('(install `zip` to also produce .zip packages)');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!existsSync(join(root, 'manifest.json'))) throw new Error('run from the repository');
  build();
}
