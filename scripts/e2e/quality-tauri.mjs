// Runs Compress presets on the quality fixtures in the running Tauri app (CDP port 9222) and
// copies each result to test-fixtures/quality/<out>/ for scripts/e2e/quality_score.py.
// Usage: node scripts/e2e/quality-tauri.mjs [out=out_ts] [files=q_screenshot,q_photo,q_scantext,q_chart] [presets=Light,Balanced,Smallest]
import { chromium } from 'playwright-core';
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const arg = (k, d) => (process.argv.find((a) => a.startsWith(k + '=')) ?? `${k}=${d}`).split('=').slice(1).join('=');
const out = resolve('test-fixtures/quality', arg('out', 'out_ts'));
const files = arg('files', 'q_screenshot,q_photo,q_scantext,q_chart').split(',');
const presets = arg('presets', 'Light,Balanced,Smallest').split(',');
const saveDir = join(homedir(), 'Downloads', 'IHatePDF');
mkdirSync(out, { recursive: true });

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const win = browser.contexts()[0].pages()[0];
for (const f of files) {
  const pdf = resolve('test-fixtures/quality', `${f}.pdf`);
  for (const p of presets) {
    const before = new Set(readdirSync(saveDir));
    await win.evaluate(() => (location.hash = '#/'));
    await win.getByText('Compress').first().waitFor();
    await win.evaluate(() => (location.hash = '#/compress'));
    await win.waitForTimeout(400);
    await win.locator('input[type=file]').first().setInputFiles(pdf);
    await win.getByText(p, { exact: true }).first().click();
    await win.getByRole('button', { name: /^Compress/ }).first().click();
    await win.getByText(/^Saved as/).waitFor({ timeout: 300_000 });
    const note = (await win.locator('aside').first().innerText()).split('\n').filter((l) => /→|dpi|smaller|unchanged/.test(l)).join(' | ');
    let saved = [];
    for (let i = 0; i < 100 && !saved.length; i++) {
      saved = readdirSync(saveDir).filter((n) => !before.has(n));
      if (!saved.length) await win.waitForTimeout(100);
    }
    const name = `${f}__${p}.pdf`;
    copyFileSync(join(saveDir, saved[0]), join(out, name));
    for (const s of saved) rmSync(join(saveDir, s), { force: true });
    console.log(`${name}: ${(statSync(pdf).size / 1024).toFixed(0)} KB → ${(statSync(join(out, name)).size / 1024).toFixed(0)} KB  ${note}`);
  }
}
await browser.close();
