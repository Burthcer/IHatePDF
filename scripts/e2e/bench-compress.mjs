// Wall time of Compress (Balanced) in the running Tauri app: Rust engine vs the TypeScript worker.
// Usage: node scripts/e2e/bench-compress.mjs file.pdf
import { chromium } from 'playwright-core';
import { resolve } from 'node:path';
const file = resolve(process.argv[2]);
const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
const win = b.contexts()[0].pages()[0];
async function run(label, native) {
  await win.goto('http://tauri.localhost/');
  if (!native) await win.evaluate(() => { delete window.ihpDesktop; });
  await win.evaluate(() => (location.hash = '#/compress'));
  await win.waitForTimeout(500);
  await win.locator('input[type=file]').first().setInputFiles(file);
  await win.evaluate(() => {
    window.__t = {};
    document.addEventListener('click', () => (window.__t.click ??= Date.now()), true);
    new MutationObserver(() => { if (window.__t.click && !window.__t.arrow && document.body.innerText.includes('→')) window.__t.arrow = Date.now(); }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  const btn = win.getByRole('button', { name: /^Compress/ }).first();
  await win.waitForFunction((el) => !el.disabled, await btn.elementHandle(), { timeout: 120_000 });
  await btn.click();
  await win.getByText(/→/).first().waitFor({ timeout: 600_000 });
  const ms = await win.evaluate(() => window.__t.arrow - window.__t.click);
  const note = (await win.locator('aside').first().innerText()).split('\n').filter((l) => /→|recompressed/.test(l)).join(' | ');
  console.log(`${label}: ${ms} ms  ${note}`);
}
await run('rust', true);
await run('typescript', false);
await b.close();
