// What does Compress do to pictures? Runs the real desktop app on the quality fixtures
// (node scripts/generateQualityFixtures.mjs), saves each result to test-fixtures/quality/out/,
// then scripts/e2e/quality_score.py compares every picture with its original.
// App: IHP_EXE (installed or unpacked app). Runs in its own profile, so it can run next to another test.
// Usage: node scripts/e2e/quality.mjs [files=q_screenshot,q_photo,q_scantext,q_chart,q_word] [presets=Light,Balanced,Smallest] [custom=]
import { _electron as electron } from 'playwright-core';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const arg = (k, d) => (process.argv.find((a) => a.startsWith(k + '=')) ?? `${k}=${d}`).split('=').slice(1).join('=');
const files = arg('files', 'q_screenshot,q_photo,q_scantext,q_chart,q_word').split(',');
const presets = arg('presets', 'Light,Balanced,Smallest').split(',').filter(Boolean);
const customs = arg('custom', '').split(',').filter(Boolean); // sizes in KB, e.g. 300
const dir = resolve('test-fixtures/quality');
const out = resolve(dir, 'out');
mkdirSync(out, { recursive: true });
const exe = process.env.IHP_EXE;
if (!exe) throw new Error('Set IHP_EXE to the app to test.');

async function withApp(fn) {
  const profile = mkdtempSync(resolve(tmpdir(), 'ihp-q-'));
  const app = await electron.launch({ executablePath: exe, args: [`--user-data-dir=${profile}`], env: { ...process.env, IHP_LOG: 'off' } });
  try {
    const win = await app.firstWindow();
    await win.getByText('Compress').first().waitFor({ timeout: 60_000 });
    return await fn(win);
  } finally {
    await app.close().catch(() => {});
    rmSync(profile, { recursive: true, force: true });
  }
}

/** Runs a tool on a file, saves the result into `out` as `name`; returns the saved size. */
async function runAndSave(win, tool, file, name, { before, action } = {}) {
  await win.evaluate(() => (location.hash = '#/'));
  await win.getByText('Compress').first().waitFor();
  await win.evaluate((t) => (location.hash = '#/' + t), tool);
  await win.waitForTimeout(400);
  await win.locator('input[type=file]').first().setInputFiles(file);
  if (before) await before(win);
  if (action) {
    const btn = win.getByRole('button', { name: action }).first();
    await btn.waitFor({ timeout: 120_000 });
    await win.waitForFunction((el) => !el.disabled, await btn.elementHandle(), { timeout: 120_000 });
    await btn.click();
  }
  const done = win.getByRole('button', { name: /^Save now$/ }).first();
  await done.waitFor({ timeout: 300_000 });
  const note = (await win.locator('aside').first().innerText().catch(() => '')).split('\n').filter((l) => /→|dpi|recompressed/.test(l)).join(' | ');
  await done.click();
  const where = win.getByText(/Downloads.IHatePDF/).first();
  await where.waitFor({ timeout: 60_000 });
  const saved = (await where.innerText()).trim();
  copyFileSync(saved, resolve(out, name));
  rmSync(saved, { force: true });
  return { size: statSync(resolve(out, name)).size, note };
}

await withApp(async (win) => {
  for (const f of files) {
    let pdf = resolve(dir, `${f}.pdf`);
    if (f.startsWith('q_word')) {
      // The user's case: a Word file with pictures → PDF with this app → Compress.
      const r = await runAndSave(win, 'wordToPdf', resolve(dir, `${f}.docx`), `${f}.pdf`);
      console.log(`${f}.docx → PDF: ${(r.size / 1024).toFixed(0)} KB`);
      pdf = resolve(out, `${f}.pdf`);
    }
    for (const p of presets) {
      const name = `${f}__${p}.pdf`;
      const r = await runAndSave(win, 'compress', pdf, name, { before: (w) => w.getByText(p, { exact: true }).first().click(), action: /^Compress/ });
      console.log(`${name}: ${(statSync(pdf).size / 1024).toFixed(0)} KB → ${(r.size / 1024).toFixed(0)} KB   ${r.note}`);
    }
    for (const kb of customs) {
      if (kb * 1024 >= statSync(pdf).size) continue; // custom sizes only shrink
      const name = `${f}__custom${kb}KB.pdf`;
      const r = await runAndSave(win, 'compress', pdf, name, {
        before: async (w) => {
          await w.getByText('Custom size', { exact: true }).first().click();
          const unit = w.locator('select').first();
          if (await unit.count()) await unit.selectOption({ label: 'KB' }).catch(() => undefined);
          await w.locator('input[type=number], input[inputmode=decimal]').first().fill(String(kb));
        },
        action: /^Compress/,
      });
      console.log(`${name}: ${(statSync(pdf).size / 1024).toFixed(0)} KB → ${(r.size / 1024).toFixed(0)} KB   ${r.note}`);
    }
  }
});
process.exit(0);
