// Builds the Windows installer: FinalApp/IHatePDF-Setup.exe (Tauri + Rust core; run `npm run build` first).
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });
run('node', ['scripts/fetch-pdfium.mjs']);
run('npx', ['tauri', 'build', '--bundles', 'nsis']);
const dir = join('src-tauri', 'target', 'release', 'bundle', 'nsis');
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const exe = `IHatePDF_${version}_x64-setup.exe`;
mkdirSync('FinalApp', { recursive: true });
copyFileSync(join(dir, exe), join('FinalApp', 'IHatePDF-Setup.exe')); // throws if this version's installer wasn't produced
console.log('FinalApp/IHatePDF-Setup.exe ready');
