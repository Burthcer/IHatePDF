// E2E for "Share to phone" in the desktop app, without touching the network or a
// phone: the server binds to 127.0.0.1 (IHP_SHARE_HOST) so Windows never shows a
// firewall prompt, and this script plays the phone. Checks folders/files/.zip
// downloads, duration, Stop, that the hotspot and Bluetooth code load (read-only:
// the hotspot isn't switched on), and that the Bluetooth list preselects nothing.
// Run `npm run build` first; IHP_EXE=FinalApp/win-unpacked/IHatePDF.exe tests the packaged app.
import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = join(tmpdir(), 'ihp-share-e2e');
rmSync(dir, { recursive: true, force: true });
const folder = join(dir, 'Lab 3 files');
mkdirSync(join(folder, 'sub', 'deeper'), { recursive: true });
mkdirSync(join(folder, 'empty'), { recursive: true });
writeFileSync(join(folder, 'a.txt'), 'hello\n');
writeFileSync(join(folder, 'sub', 'data.bin'), Buffer.alloc(5 << 20, 3));
writeFileSync(join(folder, 'sub', 'deeper', 'Résumé – final.pdf'), '%PDF-1.4 x');
const single = join(dir, 'notes.pdf');
writeFileSync(single, '%PDF-1.4 single');

let failed = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failed++;
};
const sha = (b) => createHash('sha256').update(b).digest('hex');
const unzipCheck = (file) => execFileSync('python', ['-c', 'import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(len(z.namelist()))', file]).toString().trim();

const exe = process.env.IHP_EXE;
const app = await electron.launch({
  executablePath: exe ?? createRequire(import.meta.url)('electron'),
  args: exe ? [] : ['.'],
  env: { ...process.env, IHP_SHARE_HOST: '127.0.0.1' },
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(e.message));

// Share is the first section on the home screen.
const firstSection = await win.locator('main h2').first().innerText();
check(/^Share/i.test(firstSection), `Share is the first section (${firstSection.split('\n')[0]})`);
await win.getByText('Share to phone').first().click();

const pick = (paths) => app.evaluate(({ dialog }, p) => (dialog.showOpenDialog = async () => ({ canceled: false, filePaths: p })), paths);
await pick([folder]);
await win.getByRole('button', { name: 'Add folder' }).click();
await pick([single]);
await win.getByRole('button', { name: 'Add files' }).click();
await win.getByText('2 items').waitFor();
check(await win.getByText('3 files · 5.00 MB').isVisible(), 'folder counted as 3 files');

// Same Wi-Fi (default): QR + downloads.
await win.getByRole('button', { name: 'Create QR code' }).click();
await win.locator('p.select-all').waitFor();
const url = (await win.locator('p.select-all').innerText()).replace(/^http:\/\/[^/:]+/, 'http://127.0.0.1');
check((await win.locator('img[alt^="Scan"]').getAttribute('src'))?.startsWith('data:image/png'), 'QR code shown');
const html = await (await fetch(url)).text();
check(html.includes('Download these 2 items') && html.includes('Lab 3 files') && html.includes('downloads as .zip') && html.includes('Everything, as one .zip'), 'phone page lists the folder, the file and "everything"');
const folderZip = Buffer.from(await (await fetch(`${url}f/0`)).arrayBuffer());
writeFileSync(join(dir, 'folder.zip'), folderZip);
check(unzipCheck(join(dir, 'folder.zip')) === '4', 'folder downloads as a valid .zip (3 files + empty folder)');
const allRes = await fetch(`${url}all.zip`);
const all = Buffer.from(await allRes.arrayBuffer());
writeFileSync(join(dir, 'all.zip'), all);
check(Number(allRes.headers.get('content-length')) === all.length && unzipCheck(join(dir, 'all.zip')) === '5', 'everything downloads as one valid .zip with the right size');
check(sha(Buffer.from(await (await fetch(`${url}f/1`)).arrayBuffer())) === sha(readFileSync(single)), 'single file downloads intact');
check((await fetch(url.replace(/[0-9a-f]{32}/, '0'.repeat(32)))).status === 404, 'wrong link refused');
await win.getByRole('radio', { name: '5 min' }).click();
await win.waitForTimeout(1200);
check(/^4:5\d$|^5:00$/.test(await win.locator('.tabular-nums').innerText()), '5 min restarts the countdown');
await win.getByRole('button', { name: 'Stop sharing' }).click();
await win.getByText('Sharing stopped.').waitFor();
check(await fetch(url).then(() => false, () => true), 'link dead after Stop');

// Hotspot code loads and reads Windows' hotspot settings (read-only; not switched on).
const hs = await app.evaluate(({ app: electronApp }) => {
  try {
    const s = process.mainModule.require(`${electronApp.getAppPath()}/electron/hotspot.cjs`).status();
    return { ok: true, ssid: s.ssid, hasPassword: !!s.password, on: s.on };
  } catch (e) {
    return { ok: false, error: String(e.message) };
  }
});
check(hs.ok, `hotspot API works: ${JSON.stringify(hs)}`);

// Bluetooth: scans, and never preselects a phone.
await win.getByRole('radio', { name: /Bluetooth/ }).click();
await win.getByText('Looking for phones nearby').waitFor({ timeout: 10_000 });
// It keeps scanning for about a minute (7 rounds of ~8 s).
await win.getByText('Looking for phones nearby').waitFor({ state: 'detached', timeout: 90_000 });
const options = await win.locator('select option').allInnerTexts();
check((await win.locator('select').inputValue()) === '', `no phone preselected (list: ${options.join(' | ')})`);
check(await win.getByRole('button', { name: 'Choose the phone first' }).isDisabled(), 'Send waits for a phone to be chosen');

const proc = app.process();
const exited = new Promise((r) => proc.once('exit', () => r(true)));
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
check(await Promise.race([exited, new Promise((r) => setTimeout(() => r(false), 5000))]), 'closing the window quits the app');
check(!errors.length, `no page errors ${errors.join('; ')}`);
process.exit(failed ? 1 : 0);
