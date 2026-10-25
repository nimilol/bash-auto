// Builds dist/bash-auto-<version>.zip with only the files the extension needs
// (for sharing or for the Chrome Web Store). Uses the system "zip" command.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const out = join(root, 'dist', `bash-auto-${version}.zip`);
mkdirSync(join(root, 'dist'), { recursive: true });
rmSync(out, { force: true });
execFileSync('zip', ['-r', '-q', out, 'manifest.json', '_locales', 'background', 'content', 'icons', 'lib', 'offscreen', 'panel'], { cwd: root, stdio: 'inherit' });
console.log(`Wrote ${out}`);
