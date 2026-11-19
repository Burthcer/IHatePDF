// E2E for the Tauri desktop app. Launch it first with a debug port:
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 src-tauri/target/debug/ihatepdf.exe
// then: node scripts/e2e/tauri.mjs [input.pdf]
import { chromium } from 'playwright-core';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const saveDir = join(homedir(), 'Downloads', 'IHatePDF');
const before = new Set(existsSync(saveDir) ? readdirSync(saveDir) : []);
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const win = browser.contexts()[0].pages()[0];
const errors = [];
win.on('pageerror', (e) => errors.push(e.message));
await win.evaluate(() => (location.hash = '#/'));
await win.getByText('Compress').first().waitFor();
console.log('bridge present:', await win.evaluate(() => !!window.ihpDesktop), 'url:', win.url());

const input = resolve(process.argv[2] ?? 'test-fixtures/sample-multi.pdf');
await win.evaluate(() => (location.hash = '#/compress'));
await win.locator('input[type=file]').first().setInputFiles(input);
await win.getByRole('button', { name: /^Compress/ }).click();
await win.getByText(/^Saved as/).waitFor({ timeout: 300_000 });
console.log('compress:', (await win.locator('aside').innerText()).split('\n').filter((l) => /→|Saved|IHatePDF|images/.test(l)).join(' | '));

const saved = readdirSync(saveDir).filter((f) => !before.has(f));
console.log('new files:', saved.map((f) => `${f} (${(statSync(join(saveDir, f)).size / 1024).toFixed(1)} KB)`));
if (errors.length) console.log('page errors:', errors);
await browser.close();
process.exit(saved.length && !errors.length ? 0 : 1);
