// Budget matrix: 6 tools × scans × memory budgets. Each budget stands for a PC size
// (1024 = 4 GB PC, 3072 = 6 GB, 4096 = 8 GB, 8192 = 16 GB, "none" = this PC's own budget);
// 624 = a 4 GB PC with 400 MB less, to allow for Windows' higher idle memory.
// Usage: node scripts/e2e/memory/matrix.mjs [budgets=624,1024,3072,4096] [sizes=10,50,150,500] [tools=regex]
import { A, args, input, runTool, scan } from './harness.mjs';

const o = args({ budgets: '624,1024,3072,4096', sizes: '10,50,150,500', tools: '' });
const only = o.tools ? new RegExp(o.tools) : null;
const TOOLS = [
  ['compress', (f) => [f], { action: /^Compress/ }],
  ['watermark', (f) => [f], { action: 'Add watermark' }],
  ['merge', (f) => [f, input('../scans/journal_20p.pdf')], { action: /^Merge 2 files/ }],
  ['rotate', (f) => [f], { before: A.rotateRight, action: /^Rotate \d/ }],
  ['pageNumbers', (f) => [f], { action: 'Add page numbers' }],
  ['pdfToWord', (f) => [f], { action: 'Convert to Word' }],
];
for (const budget of o.budgets.split(','))
  for (const size of o.sizes.split(','))
    for (const [tool, files, opts] of TOOLS) {
      if (only && !only.test(tool)) continue;
      const env = budget === 'none' ? {} : { IHP_MEMORY_BUDGET_MB: budget };
      await runTool(`${tool} scan_${size}MB @${budget}`, tool, files(scan(size)), { ...opts, env });
    }
process.exit(0);
