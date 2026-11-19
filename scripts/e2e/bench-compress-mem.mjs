// Peak memory (app processes: ihatepdf.exe + its WebView2 processes) while compressing, Rust engine vs TypeScript worker.
// Usage: node scripts/e2e/bench-compress-mem.mjs file.pdf   (Tauri app running with CDP on 9222; file <= 50 MB)
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const sample = () => {
  let sum = 0;
  for (const name of ['ihatepdf.exe', 'msedgewebview2.exe']) {
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
    for (const line of out.split('\n')) {
      const m = line.match(/"([\d,]+) K"/);
      if (m) sum += Number(m[1].replace(/,/g, ''));
    }
  }
  return sum / 1024;
};
const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
const win = b.contexts()[0].pages()[0];
async function run(label, native) {
  await win.goto('http://tauri.localhost/');
  if (!native) await win.evaluate(() => { delete window.ihpDesktop; });
  await win.evaluate(() => (location.hash = '#/compress'));
  await win.waitForTimeout(800);
  await win.locator('input[type=file]').first().setInputFiles(resolve(process.argv[2]));
  const btn = win.getByRole('button', { name: /^Compress/ }).first();
  await win.waitForFunction((el) => !el.disabled, await btn.elementHandle(), { timeout: 120_000 });
  await win.waitForTimeout(1500);
  const base = sample();
  let peak = base, stop = false;
  const sampler = (async () => { while (!stop) { peak = Math.max(peak, sample()); await new Promise((r) => setTimeout(r, 60)); } })();
  await btn.click();
  await win.getByText(/→/).first().waitFor({ timeout: 600_000 });
  stop = true; await sampler;
  console.log(`${label}: before ${base.toFixed(0)} MB, peak ${peak.toFixed(0)} MB, +${(peak - base).toFixed(0)} MB`);
}
await run('rust      ', true);
await run('typescript', false);
await b.close();
