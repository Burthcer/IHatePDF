// Builds the Windows installer: FinalApp/IHatePDF-Setup.exe (Tauri + Rust core; run `npm run build` first).
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });
run('node', ['scripts/fetch-pdfium.mjs']);
run('npx', ['tauri', 'build', '--bundles', 'nsis']);
const dir = join('src-tauri', 'target', 'release', 'bundle', 'nsis');
const exe = readdirSync(dir).find((f) => f.endsWith('-setup.exe'));
if (!exe) throw new Error('The installer was not produced.');
mkdirSync('FinalApp', { recursive: true });
copyFileSync(join(dir, exe), join('FinalApp', 'IHatePDF-Setup.exe'));
console.log('FinalApp/IHatePDF-Setup.exe ready');
