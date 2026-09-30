# Memory tests

Drive the real desktop app through the memory fail-safe (electron/memoryGuard.cjs) with realistic student files, at the memory budgets of different PC sizes. They run on Windows (against the installed app) and on Linux (against the dev build, under `xvfb-run -a`).

## Setup

```bash
npm ci
node scripts/generateScanFixtures.mjs        # test-fixtures/scans/: 10/50/150/500 MB scans, journals
npx tsx scripts/e2e/memory/make-inputs.ts    # test-fixtures/memory/: photos, huge PNG, Office/HTML, protected & cut-off scans
```

Which app is tested:
- **Installed app:** set `IHP_EXE` to its path, e.g. PowerShell `$env:IHP_EXE = "C:\Program Files\IHatePDF\IHatePDF.exe"`.
- **Dev build:** leave `IHP_EXE` unset and run `npm run build` first.

Results are appended to `test-fixtures/memory/results.jsonl` (or the file in `RESULTS`). `node scripts/e2e/memory/report.mjs` prints them as a table.

## The tests

| Script | What it checks |
|---|---|
| `matrix.mjs [budgets=624,1024,3072,4096] [sizes=10,50,150,500] [tools=regex]` | Compress, Watermark, Merge, Rotate, Page numbers and PDF → Word on each scan at each budget |
| `student.mjs [budgets=624,1024] [tools=regex]` | Every tool once on a normal student file |
| `busy.mjs [free=8192,2400,1800] [budget=none] [stop=yes]` | Windows busy with other programs: the job's limit shrinks, jobs slow down and pause, and the output is the same. The last case leaves barely more than the reserve, so a big job should slow, pause, then stop with "Windows is almost out of memory" |
| `lastresort.mjs` | The stops that remain: a 300-megapixel PNG at a 1 GB budget, Windows down to 300 MB free, a window stuck grabbing memory. After each, a small job must still work |

## Budgets and PC sizes

The budget is max(1 GB, min(50% RAM, RAM − 3 GB, 16 GB)). `IHP_MEMORY_BUDGET_MB` overrides it:

| Setting | Simulates |
|---|---|
| 1024 | 4 GB PC |
| 624 | 4 GB PC with 400 MB less, for Windows' higher idle memory |
| 3072 | 6 GB PC |
| 4096 | 8 GB PC |
| 8192 | 16 GB PC |
| `none` (unset) | this PC's own budget, e.g. 16 GB on a 32 GB PC |

The reserve kept free for Windows (10% of RAM, at least 1 GB) and the emergency stop (under 5% free) use this PC's real RAM. On a big PC with plenty free they won't trigger by themselves: `busy.mjs` and `lastresort.mjs` stage them through `IHP_SIMULATE_FREE_FILE` (a file holding "Windows' free memory in MB"; 0 = the real value).

## Outcomes

- **finished:** the result was saved, at normal speed.
- **slowed:** it finished, but reached the *high* or *over* level ("Low on memory: taking longer").
- **stopped:** "Stopped to protect this PC …" (the message is recorded).
- **error / timeout / harness-error:** something else went wrong. Look at the message.

Memory is the sum of the working sets of all the app's processes, from Electron's own `app.getAppMetrics()`, so it's measured the same way on Windows and Linux. *Peak (job)* is what the fail-safe counted: the growth since the job started.
