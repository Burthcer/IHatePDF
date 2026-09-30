// Windows busy with other programs: the app is told Windows' free memory through
// IHP_SIMULATE_FREE_FILE, shrinking as the job grows (free = what other programs
// leave − what the job holds). Uses this PC's own budget unless budget= is given.
// Usage: node scripts/e2e/memory/busy.mjs [free=8192,2400,1800] [budget=none]
import { writeFileSync } from 'node:fs';
import { FREE_FILE, args, runTool, scan } from './harness.mjs';

const o = args({ free: '8192,2400,1800', budget: 'none', stop: 'yes' });
const cases = [];
for (const free of o.free.split(',').map(Number)) {
  cases.push([free, 'compress', scan(150), /^Compress/]);
  cases.push([free, 'pdfToWord', scan(150), 'Convert to Word']);
  cases.push([free, 'watermark', scan(500), 'Add watermark']);
}
// Barely more than the reserve left: even the smallest limit can't hold this job, so it
// should slow down, pause, and only then stop with "Windows is almost out of memory".
if (o.stop === 'yes') cases.push(['reserve+80', 'pdfToWord', scan(500), 'Convert to Word']);

for (const [freeArg, tool, file, action] of cases) {
  let free = freeArg;
  const env = { IHP_SIMULATE_FREE_FILE: FREE_FILE, ...(o.budget === 'none' ? {} : { IHP_MEMORY_BUDGET_MB: o.budget }) };
  writeFileSync(FREE_FILE, '0'); // real value until the first state arrives
  let reserveMB = null;
  await runTool(`${tool} ${file.split(/[\\/]/).pop()} · Windows leaves ${freeArg} MB free`, tool, [file], {
    action,
    env,
    onTick: (st) => {
      // reserve = max(1 GB, 10% of RAM): the job's limit is what it holds + free − reserve.
      reserveMB ??= Math.max(1024, st.totalMB * 0.1);
      if (freeArg === 'reserve+80') free = Math.round(reserveMB + 80);
      writeFileSync(FREE_FILE, String(Math.max(50, free - (st.jobMB ?? 0))));
    },
  });
}
writeFileSync(FREE_FILE, '0');
process.exit(0);
