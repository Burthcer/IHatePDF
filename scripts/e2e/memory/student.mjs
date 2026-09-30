// Every tool once on a normal student file (50 MB scan, 10-20 page journal, Office/HTML files, photos).
// Usage: node scripts/e2e/memory/student.mjs [budgets=624,1024] [tools=regex]
import { A, args, input, runTool, scan } from './harness.mjs';

const o = args({ budgets: '624,1024', tools: '' });
const only = o.tools ? new RegExp(o.tools) : null;
const s50 = scan(50), j10 = input('../scans/journal_10p.pdf'), j20 = input('../scans/journal_20p.pdf');
const TESTS = [
  ['merge', [s50, j20], { action: /^Merge 2 files/ }],
  ['split', [s50], { before: A.splitAll, action: /^Split into|^Extract/ }],
  ['organize', [j20], { before: A.organizeReverse, action: 'Save new page order' }],
  ['rotate', [s50], { before: A.rotateRight, action: /^Rotate \d/ }],
  ['crop', [s50], { action: /^Crop$/ }],
  ['editPdf', [j20], { before: A.editFirst, action: /^Download$/ }],
  ['sign', [j20], { before: A.sign, action: /^Sign \(1/ }],
  ['watermark', [s50], { action: 'Add watermark' }],
  ['pageNumbers', [s50], { action: 'Add page numbers' }],
  ['redact', [j20], { before: A.redactSearch('the'), action: /^Redact \d/ }],
  ['compress', [s50], { action: /^Compress/ }],
  ['repair', [input('scan_50MB_cut90.pdf')], { action: 'Repair' }],
  ['pdfToPdfa', [s50], { action: 'Convert to PDF/A-2b' }],
  ['protect', [s50], { before: A.protectPw, action: 'Encrypt PDF' }],
  ['unlock', [input('scan_50MB_protected.pdf')], { before: A.unlockPw, action: 'Remove protection' }],
  ['pdfToWord', [j20], { action: 'Convert to Word' }],
  ['pdfToWord', [s50], { action: 'Convert to Word' }],
  ['pdfToExcel', [j20], { action: 'Convert to Excel' }],
  ['pdfToPpt', [s50], { action: 'Convert to PowerPoint' }],
  ['pdfToMarkdown', [j20], {}],
  ['pdfToJpg', [s50], { action: /^Export/ }],
  ['imageToPdf', Array.from({ length: 30 }, (_, i) => input(`photos/p${String(i).padStart(2, '0')}.jpg`)), { action: /^Create PDF \(30/ }],
  ['scanToPdf', null, { before: async (w) => { await w.locator('input[type=file]').last().setInputFiles(input('photo_48MP.jpg')); const use = w.getByRole('button', { name: /^(Use|Done|Save|Apply|Keep)/ }).first(); if (await use.isVisible({ timeout: 60_000 }).catch(() => false)) await use.click(); }, action: /^Make PDF \(1/ }],
  ['wordToPdf', [input('big.docx')], {}],
  ['excelToPdf', [input('big_10k_rows.xlsx')], {}],
  ['pptToPdf', [input('big_150_slides.pptx')], {}],
  ['htmlToPdf', [input('long.html')], { before: async (w) => { await w.waitForFunction(() => document.querySelector('textarea')?.value.includes('Long report')); }, action: 'Create PDF' }],
];
for (const budget of o.budgets.split(','))
  for (const [tool, files, opts] of TESTS) {
    if (only && !only.test(tool)) continue;
    const what = files ? files[0].split(/[\\/]/).pop() + (files.length > 1 ? ` +${files.length - 1}` : '') : 'photo_48MP.jpg';
    await runTool(`${tool} ${what} @${budget}`, tool, files, { ...opts, env: budget === 'none' ? {} : { IHP_MEMORY_BUDGET_MB: budget } });
  }
// Compare shows its result on the page rather than saving a file.
if (!only || only.test('compare'))
  for (const budget of o.budgets.split(','))
    await runTool(`compare journal_10p vs journal_20p @${budget}`, 'compare', null, {
      env: budget === 'none' ? {} : { IHP_MEMORY_BUDGET_MB: budget },
      before: async (w) => {
        const i = w.locator('input[type=file]');
        await i.nth(0).setInputFiles(j10);
        await i.nth(1).setInputFiles(j20);
        await w.getByRole('button', { name: /^Compare$/ }).click();
        await w.getByText(/\d+ changes? ·|differ too much|identical/i).first().waitFor({ timeout: 10 * 60_000 });
        // Stand-in for "Save now" so runTool counts it as finished.
        await w.evaluate(() => { const b = document.createElement('button'); b.textContent = 'Save now'; b.onclick = () => b.remove(); document.body.append(b); });
      },
    });
process.exit(0);
