// The last resorts still protect the PC, and the app stays usable afterwards:
//  1. a piece that can't be split (a 300-megapixel PNG at a 1 GB budget) is refused at once;
//  2. Windows nearly out of memory (300 MB free, staged) stops the running job;
//  3. a window stuck grabbing memory is restarted with a notice.
// Usage: node scripts/e2e/memory/lastresort.mjs
import { writeFileSync } from 'node:fs';
import { FREE_FILE, input, launch, record, runTool, scan } from './harness.mjs';

/** A small job right after, in the same window. */
async function stillUsable(win) {
  try {
    await win.evaluate(() => (location.hash = '#/'));
    await win.getByText('Compress').first().waitFor({ timeout: 30_000 });
    await win.evaluate(() => (location.hash = '#/watermark'));
    await win.locator('input[type=file]').first().setInputFiles(input('../scans/journal_10p.pdf'));
    const btn = win.getByRole('button', { name: 'Add watermark' }).first();
    await btn.waitFor({ timeout: 60_000 });
    await win.waitForFunction((el) => !el.disabled, await btn.elementHandle(), { timeout: 60_000 });
    await btn.click();
    return await win.getByRole('button', { name: /^Save now$/ }).first().waitFor({ timeout: 120_000 }).then(() => 'yes', () => 'NO (the job after did not finish)');
  } catch (e) {
    return 'NO: ' + String(e.message).split('\n')[0].slice(0, 120);
  }
}

// 1.
{
  const { row, app, win } = await runTool('last resort: 300 MP PNG → PDF @1024', 'imageToPdf', [input('huge_300MP.png')], { action: /^Create PDF \(1/, env: { IHP_MEMORY_BUDGET_MB: '1024' }, keepApp: true });
  record({ name: '  … app still usable afterwards', outcome: await stillUsable(win) });
  await app.close();
}
// 2.
{
  writeFileSync(FREE_FILE, '0');
  setTimeout(() => writeFileSync(FREE_FILE, '300'), 3000);
  const { app, win } = await runTool('last resort: Windows down to 300 MB free during compress 150 MB', 'compress', [scan(150)], { action: /^Compress/, env: { IHP_SIMULATE_FREE_FILE: FREE_FILE }, keepApp: true });
  writeFileSync(FREE_FILE, '0');
  await win.waitForTimeout(1500);
  record({ name: '  … app still usable afterwards', outcome: await stillUsable(win) });
  await app.close();
}
// 3.
{
  const { app, win } = await launch({ IHP_MEMORY_BUDGET_MB: '1024' });
  await app.evaluate(({ BrowserWindow }) => { globalThis.__nav = []; BrowserWindow.getAllWindows()[0].webContents.on('did-start-navigation', (e) => globalThis.__nav.push(e.url)); });
  const t0 = Date.now();
  win.evaluate(() => { const keep = []; const until = Date.now() + 60000; while (Date.now() < until) { const a = new Uint8Array(32 << 20); for (let i = 0; i < a.length; i += 4096) a[i] = 1; keep.push(a); } }).catch(() => undefined);
  let nav = [];
  for (let i = 0; i < 60 && !nav.length; i++) { await new Promise((r) => setTimeout(r, 500)); nav = await app.evaluate(() => globalThis.__nav); }
  const secs = +((Date.now() - t0) / 1000).toFixed(1);
  await new Promise((r) => setTimeout(r, 3000));
  const body = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('document.body.innerText')).catch(() => '');
  record({ name: 'last resort: stuck window grabbing memory @1024', outcome: nav[0]?.includes('recovered=memory') ? 'restarted' : 'NOT restarted', secs, message: /restarted to protect this PC/.test(body) ? 'notice shown' : 'no notice' });
  await app.close();
}
process.exit(0);
