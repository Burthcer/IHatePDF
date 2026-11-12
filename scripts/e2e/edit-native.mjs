// Installed app: Edit PDF end to end. A Latin edit must go through the Rust engine (`edit_apply` for the preview
// and for the export, no fallback warning); a Greek edit must fall back to the TypeScript engine and still work.
// Usage: E2E_CDP=http://127.0.0.1:9222 node scripts/e2e/edit-native.mjs
import { launch, openTool, upload, runAndDownload } from './harness.mjs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const { browser, page, logs } = await launch();
let bad = 0;
async function scenario(label, typed, expectRust) {
  logs.length = 0;
  await openTool(page, 'editPdf');
  const seen = [];
  const onReq = (r) => /ipc\.localhost\/(\w+)/.test(r.url()) && seen.push(r.url().match(/ipc\.localhost\/(\w+)/)[1]);
  page.on('request', onReq);
  await upload(page, resolve('test-fixtures/complex/complex.pdf'));
  const blocks = page.locator('[title="Double-click to edit"]');
  await blocks.nth(2).waitFor({ timeout: 60_000 });
  await blocks.nth(2).dblclick();
  await page.keyboard.press('Control+A');
  await page.keyboard.type(typed);
  await page.keyboard.press('Escape');
  await page.mouse.click(1300, 800);
  await page.waitForTimeout(2500); // let the preview render
  const r = await runAndDownload(page, /^Download$/, 'edited.pdf');
  const text = execFileSync('node', ['scripts/e2e/items.mjs', r.path, '1'], { encoding: 'utf8' });
  page.off('request', onReq);
  const all = seen;
  const calls = all.filter((c) => c === 'edit_apply').length;
  if (process.env.DEBUG_CALLS) console.log(label, 'invoke calls:', all.join(','), 'logs:', logs.join(' | ').slice(0, 600));
  const declined = logs.filter((l) => /declined/.test(l));
  const textOk = text.includes(typed) && !text.includes('Quarterly Operations');
  const routeOk = expectRust ? calls >= 2 && !declined.length : declined.length > 0;
  const ok = textOk && routeOk;
  if (!ok) bad++;
  console.log(ok ? 'PASS' : 'FAIL', label, `edit_apply calls: ${calls}, fallback warnings: ${declined.length}, text replaced: ${textOk}`, ok ? '' : declined.join(' | ').slice(0, 200));
}
await scenario('Latin edit (Rust)', 'Edited by the Rust engine.', true);
await scenario('Greek edit (TypeScript fallback)', 'Γειά σου κόσμε', false);
await browser.close();
process.exit(bad ? 1 : 0);
