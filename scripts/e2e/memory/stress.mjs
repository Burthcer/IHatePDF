// The principal's stress test: a 5 GB scanned PDF and a 10,000-page PDF through the tools.
// Inputs: node --max-old-space-size=8192 scripts/generateStressFixtures.mjs
// Usage: node scripts/e2e/memory/stress.mjs [files=5gb,10000p] [budgets=none,1024] [tools=regex]
// Each run also writes the app's usage log to test-fixtures/stress/logs (see scripts/log-summary.mjs).
import { A, REPO, args, input, runTool, scan } from './harness.mjs';
import { resolve } from 'node:path';

const o = args({ files: '5gb,10000p', budgets: 'none,1024', tools: '' });
const only = o.tools ? new RegExp(o.tools) : null;
const stress = (n) => resolve(REPO, 'test-fixtures/stress', n);
const j20 = input('../scans/journal_20p.pdf');
const SETS = {
  '5gb': {
    file: stress('stress_5GB.pdf'),
    tests: [
      ['watermark', {}, 'Add watermark'],
      ['rotate', { before: A.rotateRight }, /^Rotate \d/],
      ['pageNumbers', {}, 'Add page numbers'],
      ['merge', { extra: [j20] }, /^Merge 2 files/],
      ['protect', { before: A.protectPw }, 'Encrypt PDF'],
      ['pdfToPdfa', {}, 'Convert to PDF/A-2b'],
      ['split', { before: A.splitAll }, /^Split into|^Extract/],
      ['compress', {}, /^Compress/],
    ],
  },
  '10000p': {
    file: stress('stress_10000p.pdf'),
    tests: [
      ['watermark', {}, 'Add watermark'],
      ['rotate', { before: A.rotateRight }, /^Rotate \d/],
      ['pageNumbers', {}, 'Add page numbers'],
      ['merge', { extra: [j20] }, /^Merge 2 files/],
      ['organize', { before: A.organizeReverse }, 'Save new page order'],
      ['split', { before: A.splitAll }, /^Split into|^Extract/],
      ['protect', { before: A.protectPw }, 'Encrypt PDF'],
      ['compress', {}, /^Compress/],
      ['pdfToPdfa', {}, 'Convert to PDF/A-2b'],
      ['pdfToMarkdown', {}, null],
      ['pdfToWord', {}, 'Convert to Word'],
      ['pdfToExcel', {}, 'Convert to Excel'],
      ['redact', { before: A.redactSearch('lab') }, /^Redact \d/],
      ['editPdf', { before: A.editFirst }, /^Download$/],
    ],
  },
};
// Heavy jobs on a simulated 4 GB PC (1 GB budget) are limited to these.
const small = /^(watermark|rotate|pageNumbers|merge|protect|compress|pdfToWord)$/;

for (const set of o.files.split(',')) {
  const { file, tests } = SETS[set];
  for (const budget of o.budgets.split(',')) {
    for (const [tool, opts, action] of tests) {
      if (only && !only.test(tool)) continue;
      if (budget !== 'none' && !small.test(tool)) continue;
      const env = { IHP_LOG_DIR: stress('logs'), ...(budget === 'none' ? {} : { IHP_MEMORY_BUDGET_MB: budget }) };
      await runTool(`${tool} ${set} @${budget}`, tool, [file, ...(opts.extra ?? [])], { action: action ?? undefined, before: opts.before, env, timeout: 100 * 60_000 });
    }
  }
}
process.exit(0);
