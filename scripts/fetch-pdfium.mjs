// Downloads the prebuilt PDFium library (https://github.com/bblanchon/pdfium-binaries, BSD/Apache-2.0)
// used by the Rust renderer into src-tauri/resources/. Run once before `cargo tauri build` (build:exe does it).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dest = resolve('src-tauri/resources/pdfium.dll');
if (existsSync(dest)) process.exit(0);
const url = process.env.PDFIUM_URL ?? 'https://github.com/bblanchon/pdfium-binaries/releases/latest/download/pdfium-win-x64.tgz';
console.log('Downloading PDFium from', url);
const res = await fetch(url, { redirect: 'follow' });
if (!res.ok) throw new Error(`PDFium download failed: ${res.status}`);
const dir = mkdtempSync(join(tmpdir(), 'pdfium-'));
const tgz = join(dir, 'pdfium.tgz');
writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
execFileSync(process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe') : 'tar', ['-xzf', tgz, '-C', dir]);
mkdirSync(resolve('src-tauri/resources'), { recursive: true });
copyFileSync(join(dir, 'bin', 'pdfium.dll'), dest);
rmSync(dir, { recursive: true, force: true });
console.log('PDFium ready at', dest);
