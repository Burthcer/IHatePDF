// E2E for the desktop app: startup time, tools running under app://,
// auto-save into Downloads/IHatePDF, and that closing the window quits.
// Needs the Electron binary (node_modules/electron/dist) and a display
// (on Linux: xvfb-run node scripts/e2e/electron.mjs). Run `npm run build` first.
import { _electron as electron } from 'playwright-core';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const saveDir = join(homedir(), 'Downloads', 'IHatePDF');
const before = new Set(existsSync(saveDir) ? readdirSync(saveDir) : []);
const t0 = Date.now();
const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: ['.', '--no-sandbox'] });
const win = await app.firstWindow();
await win.getByText('Compress').first().waitFor();
const startup = Date.now() - t0;
await win.waitForTimeout(300);
const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible());
console.log(`window visible=${visible}, home ready in ${startup} ms, url=${win.url()}`);

const errors = [];
win.on('pageerror', (e) => errors.push(e.message));

// Compress a file with JPEG 2000 / CMYK images (exercises the WASM decoder) and let it auto-save.
await win.evaluate(() => (location.hash = '#/compress'));
await win.locator('input[type=file]').first().setInputFiles(resolve('test-fixtures/big/mixed_images.pdf'));
await win.getByRole('button', { name: /^Compress/ }).click();
await win.getByText(/^Saved as/).waitFor({ timeout: 300_000 });
await win.getByText(/Downloads.IHatePDF/).waitFor({ timeout: 10_000 }).catch(() => console.log('!! saved location not shown'));
console.log('compress:', (await win.locator('aside').innerText()).split('\n').filter((l) => /→|Saved|IHatePDF|images/.test(l)).join(' | '));

// Editor renders pages with pdf.js (worker + fonts over app://).
await win.evaluate(() => (location.hash = '#/editPdf'));
await win.locator('input[type=file]').first().setInputFiles(resolve('test-fixtures/complex/complex.pdf'));
await win.locator('[title="Double-click to edit"]').first().waitFor({ timeout: 60_000 });
console.log('editor: text blocks detected =', await win.locator('[title="Double-click to edit"]').count());

const saved = readdirSync(saveDir).filter((f) => !before.has(f));
console.log('new files in', saveDir, saved.map((f) => `${f} (${(statSync(join(saveDir, f)).size / 1048576).toFixed(2)} MB)`));

// Closing the window must end the whole app.
const proc = app.process();
const exited = new Promise((r) => proc.once('exit', () => r(true)));
const tClose = Date.now();
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
const quit = await Promise.race([exited, new Promise((r) => setTimeout(() => r(false), 5000))]);
console.log(`closed window → process exited: ${quit} (${Date.now() - tClose} ms)`);
if (errors.length) console.log('page errors:', errors);
if (!quit) proc.kill();
process.exit(quit && visible && saved.length && !errors.length ? 0 : 1);
