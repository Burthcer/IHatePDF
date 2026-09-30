# Windows tests

**Results report (Dev's laptop):** `C:\Users\Asus\Desktop\PropPres\IHatePDF-Windows-tests.md` (latest run's tables, verdict, history, open issues). Update that same file after each run.

This file is the memory for Windows test sessions. **Read it before testing; add your run to "Runs" (newest first) after.** Never delete earlier runs. Raw results (`test-fixtures/`) stay local and are never committed; only summaries go here.

## Machine

| | |
|---|---|
| Laptop | Dev's Windows 11 Home (build 26200), Intel Core Ultra 9 185H, 31.4 GB RAM |
| Repo clone | `C:\Users\Asus\Desktop\PropPres\IHatePDF-repo` |
| Installers kept | `C:\Users\Asus\Desktop\PropPres\_installers\<version>\IHatePDF-Setup.exe` |
| Installed app | `C:\Program Files\IHatePDF\IHatePDF.exe` (per-machine install; the installer needs one UAC "Yes", which Dev has to click) |
| Saved outputs | `%USERPROFILE%\Downloads\IHatePDF\` (the harness deletes each output after a run) |

## Setup

```powershell
# 1. Install the build under test over the old one (UAC prompt: someone must click Yes).
gh release download v1.3.1-beta.3 -R Burthcer/IHatePDF -p IHatePDF-Setup.exe -D C:\Users\Asus\Desktop\PropPres\_installers\v1.3.1-beta.3
Start-Process C:\Users\Asus\Desktop\PropPres\_installers\v1.3.1-beta.3\IHatePDF-Setup.exe -ArgumentList /S -Wait
# Check: Settings → Apps shows ONE "IHatePDF" with the new version:
Get-ItemProperty 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' | ? DisplayName -match IHatePDF | select DisplayName,DisplayVersion

# 2. Repo and inputs (skip the generators if test-fixtures/scans, /memory, /misc already exist).
cd C:\Users\Asus\Desktop\PropPres\IHatePDF-repo
git checkout <branch>; git pull; npm ci
node scripts/generateScanFixtures.mjs            # test-fixtures/scans/
npx tsx scripts/e2e/memory/make-inputs.ts        # test-fixtures/memory/
npx tsx scripts/generateTestFixtures.ts          # test-fixtures/ (npm test inputs)
node scripts/e2e/make-e2e-fixtures.mjs           # test-fixtures/misc/ + big/scan_photos.pdf (all-tools.mjs inputs)

# 3. Point the memory harness at the installed app; one RESULTS file per test group and date.
$env:IHP_EXE = "C:\Program Files\IHatePDF\IHatePDF.exe"
```

From Git Bash the same works with `export IHP_EXE="C:/Program Files/IHatePDF/IHatePDF.exe"`.

### Environment variables

| Variable | Meaning |
|---|---|
| `IHP_EXE` | Test this exe (the installed app). Unset: the dev build (`npm run build` first) |
| `IHP_MEMORY_BUDGET_MB` | Override the budget to simulate a PC size (table below) |
| `IHP_SIMULATE_FREE_FILE` | File holding "Windows' free memory in MB" (0 = real). `busy.mjs`/`lastresort.mjs` set it |
| `RESULTS` | JSON-lines file results are appended to, e.g. `test-fixtures/memory/2026-09-30-matrix.jsonl` |
| `CHROMIUM_PATH` | Browser for `all-tools.mjs`; default on Windows is the installed Microsoft Edge |

### Budgets and PC sizes

Budget = max(1 GB, min(50% RAM, RAM − 3 GB, 16 GB)). Reserve kept free for Windows = max(1 GB, 10% RAM); **3.2 GB on this laptop**, 1.6 GB on a 16 GB PC, 1 GB on a 4–8 GB PC.

| `IHP_MEMORY_BUDGET_MB` | Simulates |
|---|---|
| 624 | 4 GB PC with 400 MB less (Windows' higher idle memory) |
| 1024 | 4 GB PC |
| 3072 | 6 GB PC |
| 4096 | 8 GB PC |
| 8192 | 16 GB PC |
| unset (`none`) | this laptop: 16 GB |

## Tests and expected results

| | Command | Expected |
|---|---|---|
| A | `node scripts/e2e/memory/windows-checks.mjs only=idle` (+ Windows "In use" with the app closed: `Get-Counter '\Memory\Available MBytes'`) | Home screen well under 1 GB; with the 500 MB scan open in Rotate, a few hundred MB more |
| B | `RESULTS=…-matrix.jsonl node scripts/e2e/memory/matrix.mjs budgets=624,1024,3072,4096,8192,none` | All 144 finish; some "slowed" at 624/1024; every Compress says "N of N images recompressed". PDF→Word on the 500 MB scan may stop at 624 (built in one piece) but must finish at 1024 |
| C | `RESULTS=…-student.jsonl node scripts/e2e/memory/student.mjs budgets=624,1024` | All 56 finish |
| D | `RESULTS=…-busy.jsonl node scripts/e2e/memory/busy.mjs` (defaults `free=8192,reserve+762,reserve+162`) | 8192 and reserve+762: finish. reserve+162: slow/pause with "Windows is short of memory…", still recompress every image. Final reserve+80 case: slow, pause, then stop with "Windows is almost out of memory" (see Known limits: on 32 GB it finishes) |
| E | `RESULTS=…-lastresort.jsonl node scripts/e2e/memory/lastresort.mjs` | 300 MP PNG refused at once; 300 MB free → running job stops within ~3 s; stuck window restarted in ~1.5 s with the notice; "app still usable afterwards: yes" each time |
| F | By hand: fill Windows' memory (other programs/tabs) until Task Manager shows < ~2 GB available, then Compress the 500 MB scan in the app | Slows and finishes, or stops only with the Windows message; the PC stays responsive |
| G | `node scripts/e2e/memory/windows-checks.mjs only=thumbs` | Seconds to the first 12 thumbnails of the 50 MB scan in Rotate at 1024 and unset. Judge whether 1024 is too slow for a lab PC |
| H | `node scripts/e2e/memory/windows-checks.mjs only=text`, then open `test-fixtures/memory/text-check/*.pdf` in Edge (and Adobe Reader if installed); PDF→Word on a file with **horizontal** Hindi/Chinese text | "गोपनीय", "机密" render correctly with joined letters; extractable text; Word shows them |
| I | `npm test`; then `npx vite preview --port 4173` and, in another terminal, `node scripts/e2e/all-tools.mjs` | 17/17 + 34/34; 29/29 |

Print a results file as a table: `node scripts/e2e/memory/report.mjs <file.jsonl>`.

Manual checks that need Dev at the laptop: the SmartScreen "More info → Run anyway" flow (only appears for a browser-downloaded installer), test F, and Share to phone (Dev tests that personally).

## Baselines (this laptop)

| | v1.3.1-beta.3 (30 Sep 2026) |
|---|---|
| Windows "In use", IHatePDF closed | 15.0 GB of 31.4 GB (Claude desktop and other apps open) |
| App, home screen | 398 MB |
| App, 500 MB scan open in Rotate | 1,424 MB (12 thumbnails after 1.1 s) |
| First 12 thumbnails, 50 MB scan, Rotate @1024 | 7.4 s |
| Same, budget unset | 0.9 s |
| Startup | about 8 s for the first launch after install, then under 0.5 s |

## Runs

### 2026-09-30 · v1.3.1-beta.3 (branch `claude/bold-cori-o7rx16`, commit 6134285) · Windows 11 26200, 31.4 GB

**Verdict:** the 4 GB problem of 1.3.0 is fixed: nothing in B or C stopped (200 runs). E behaves as designed. One real issue in D (Compress stops when Windows is within ~160 MB of the reserve). H passes. I passes after two harness fixes.

**Setup:** installer upgraded 1.3.0 in place: one Apps entry, "IHatePDF 1.3.1-beta.3"; desktop and Start-menu shortcuts kept. SmartScreen flow **not checked** (needs a browser download and a person).

**Compared with the last Windows run (v1.3.0, 29–30 Sep, Claude's own harness, JPEG scans of the same kind):** at 1 GB, 1.3.0 stopped *every* Compress (10/20/50/150/500 MB) and Watermark on 500 MB within 1–2 s; 1.3.1-beta.3 finishes all of them (Compress 10 MB 2.9 s, 50 MB 10.6 s, 150 MB 31 s, 500 MB 121 s, all images recompressed; Watermark 500 MB 2.6 s). At 6/8 GB and unset, speeds are about the same (Compress 500 MB: 87–108 s now; 1.3.0 took 85–94 s on a 503 MB/141-page scan). App idle on the home screen is lower (398 MB; 1.3.0 idled at 0.55–0.9 GB). **Nothing got worse.**

**A. Idle:** see Baselines.

**B. Matrix (144 runs): 121 finished, 23 slowed, 0 stopped.**

| Budget | finished | slowed | stopped |
|---|---|---|---|
| 624 | 10 | 14 | 0 |
| 1024 | 15 | 9 | 0 |
| 3072 / 4096 / 8192 / none | 24 each | 0 | 0 |

Every Compress: 3/3, 15/15, 44/44, 144/144 images recompressed. PDF→Word on the 500 MB scan finished at 624 too (slowed, 92 s).

<details><summary>All 144 rows</summary>

| Test | Outcome | Time | Peak (app) | Peak (job) | Level reached | Note |
|---|---|---|---|---|---|---|
| compress scan_10MB @624 | slowed | 3.9 s | 1.0 GB | 779 MB | over | 10.2 MB → 831 KB (−92%) / 3 of 3 images recompressed |
| watermark scan_10MB @624 | finished | 0.4 s | 0.6 GB | 274 MB | normal |  |
| merge scan_10MB @624 | finished | 0.2 s | 0.6 GB | 233 MB | normal |  |
| rotate scan_10MB @624 | slowed | 0.3 s | 0.9 GB | 582 MB | high |  |
| pageNumbers scan_10MB @624 | finished | 0.3 s | 0.5 GB | 195 MB | normal |  |
| pdfToWord scan_10MB @624 | slowed | 4 s | 1.1 GB | 771 MB | over |  |
| compress scan_50MB @624 | slowed | 19.9 s | 1.1 GB | 697 MB | over | 50.9 MB → 4.04 MB (−92%) / 15 of 15 images recompressed |
| watermark scan_50MB @624 | finished | 0.5 s | 0.8 GB | 194 MB | normal |  |
| merge scan_50MB @624 | finished | 0.4 s | 0.7 GB | 248 MB | normal |  |
| rotate scan_50MB @624 | slowed | 0.4 s | 1.0 GB | 512 MB | high |  |
| pageNumbers scan_50MB @624 | finished | 0.4 s | 0.6 GB | 194 MB | normal |  |
| pdfToWord scan_50MB @624 | slowed | 10.2 s | 1.2 GB | 952 MB | over |  |
| compress scan_150MB @624 | slowed | 55.4 s | 1.2 GB | 764 MB | over | 148.8 MB → 11.7 MB (−92%) / 44 of 44 images recompressed |
| watermark scan_150MB @624 | slowed | 0.9 s | 0.9 GB | 489 MB | high |  |
| merge scan_150MB @624 | finished | 0.9 s | 0.8 GB | 333 MB | normal |  |
| rotate scan_150MB @624 | slowed | 0.9 s | 1.1 GB | 600 MB | high |  |
| pageNumbers scan_150MB @624 | slowed | 0.9 s | 0.9 GB | 446 MB | high |  |
| pdfToWord scan_150MB @624 | slowed | 28.8 s | 1.2 GB | 908 MB | over |  |
| compress scan_500MB @624 | slowed | 158 s | 1.2 GB | 774 MB | over | 486.7 MB → 38.4 MB (−92%) / 144 of 144 images recompressed |
| watermark scan_500MB @624 | finished | 2.6 s | 1.1 GB | 725 MB | over |  |
| merge scan_500MB @624 | finished | 2.5 s | 0.9 GB | 586 MB | high |  |
| rotate scan_500MB @624 | slowed | 1.9 s | 1.3 GB | 733 MB | over |  |
| pageNumbers scan_500MB @624 | finished | 2 s | 0.8 GB | 307 MB | normal |  |
| pdfToWord scan_500MB @624 | slowed | 91.8 s | 1.7 GB | 1417 MB | critical |  |
| compress scan_10MB @1024 | slowed | 2.9 s | 1.1 GB | 898 MB | high | 10.2 MB → 831 KB (−92%) / 3 of 3 images recompressed |
| watermark scan_10MB @1024 | finished | 0.3 s | 0.6 GB | 194 MB | normal |  |
| merge scan_10MB @1024 | finished | 0.1 s | 0.5 GB | 194 MB | normal |  |
| rotate scan_10MB @1024 | finished | 0.1 s | 0.9 GB | 620 MB | normal |  |
| pageNumbers scan_10MB @1024 | finished | 0.2 s | 0.5 GB | 194 MB | normal |  |
| pdfToWord scan_10MB @1024 | finished | 3.5 s | 1.0 GB | 703 MB | normal |  |
| compress scan_50MB @1024 | slowed | 10.6 s | 1.3 GB | 930 MB | high | 50.9 MB → 4.04 MB (−92%) / 15 of 15 images recompressed |
| watermark scan_50MB @1024 | finished | 0.4 s | 0.7 GB | 199 MB | normal |  |
| merge scan_50MB @1024 | finished | 0.4 s | 0.7 GB | 190 MB | normal |  |
| rotate scan_50MB @1024 | finished | 0.3 s | 0.9 GB | 575 MB | normal |  |
| pageNumbers scan_50MB @1024 | finished | 0.4 s | 0.6 GB | 194 MB | normal |  |
| pdfToWord scan_50MB @1024 | slowed | 10.7 s | 1.2 GB | 961 MB | high |  |
| compress scan_150MB @1024 | slowed | 31.3 s | 1.4 GB | 1012 MB | high | 148.8 MB → 11.7 MB (−92%) / 44 of 44 images recompressed |
| watermark scan_150MB @1024 | finished | 1 s | 1.0 GB | 488 MB | normal |  |
| merge scan_150MB @1024 | finished | 0.9 s | 0.8 GB | 542 MB | normal |  |
| rotate scan_150MB @1024 | finished | 0.9 s | 1.1 GB | 583 MB | normal |  |
| pageNumbers scan_150MB @1024 | finished | 0.9 s | 0.7 GB | 471 MB | normal |  |
| pdfToWord scan_150MB @1024 | slowed | 42.7 s | 1.4 GB | 1122 MB | over |  |
| compress scan_500MB @1024 | slowed | 120.6 s | 1.4 GB | 973 MB | high | 486.7 MB → 38.4 MB (−92%) / 144 of 144 images recompressed |
| watermark scan_500MB @1024 | finished | 2.6 s | 1.1 GB | 768 MB | high |  |
| merge scan_500MB @1024 | finished | 2 s | 0.9 GB | 310 MB | normal |  |
| rotate scan_500MB @1024 | slowed | 2.5 s | 1.3 GB | 931 MB | high |  |
| pageNumbers scan_500MB @1024 | slowed | 2.5 s | 1.2 GB | 936 MB | high |  |
| pdfToWord scan_500MB @1024 | slowed | 144.5 s | 1.6 GB | 1196 MB | over |  |
| compress scan_10MB @3072 | finished | 2.9 s | 1.1 GB | 922 MB | normal | 10.2 MB → 831 KB (−92%) / 3 of 3 images recompressed |
| watermark scan_10MB @3072 | finished | 0.3 s | 0.6 GB | 194 MB | normal |  |
| merge scan_10MB @3072 | finished | 0.3 s | 0.7 GB | 190 MB | normal |  |
| rotate scan_10MB @3072 | finished | 0.1 s | 0.8 GB | 533 MB | normal |  |
| pageNumbers scan_10MB @3072 | finished | 0.2 s | 0.5 GB | 195 MB | normal |  |
| pdfToWord scan_10MB @3072 | finished | 0.9 s | 1.1 GB | 494 MB | normal |  |
| compress scan_50MB @3072 | finished | 10.1 s | 1.6 GB | 1126 MB | normal | 50.9 MB → 4.04 MB (−92%) / 15 of 15 images recompressed |
| watermark scan_50MB @3072 | finished | 0.5 s | 0.9 GB | 196 MB | normal |  |
| merge scan_50MB @3072 | finished | 0.3 s | 0.8 GB | 190 MB | normal |  |
| rotate scan_50MB @3072 | finished | 0.4 s | 1.1 GB | 530 MB | normal |  |
| pageNumbers scan_50MB @3072 | finished | 0.4 s | 0.6 GB | 195 MB | normal |  |
| pdfToWord scan_50MB @3072 | finished | 3 s | 1.3 GB | 740 MB | normal |  |
| compress scan_150MB @3072 | finished | 26 s | 1.5 GB | 1115 MB | normal | 148.8 MB → 11.7 MB (−92%) / 44 of 44 images recompressed |
| watermark scan_150MB @3072 | finished | 0.9 s | 0.9 GB | 285 MB | normal |  |
| merge scan_150MB @3072 | finished | 1 s | 0.9 GB | 307 MB | normal |  |
| rotate scan_150MB @3072 | finished | 1 s | 1.6 GB | 1268 MB | normal |  |
| pageNumbers scan_150MB @3072 | finished | 0.9 s | 1.0 GB | 328 MB | normal |  |
| pdfToWord scan_150MB @3072 | finished | 7.2 s | 1.5 GB | 842 MB | normal |  |
| compress scan_500MB @3072 | finished | 107.9 s | 1.6 GB | 1166 MB | normal | 486.7 MB → 38.4 MB (−92%) / 144 of 144 images recompressed |
| watermark scan_500MB @3072 | finished | 2.1 s | 1.0 GB | 547 MB | normal |  |
| merge scan_500MB @3072 | finished | 2 s | 0.9 GB | 535 MB | normal |  |
| rotate scan_500MB @3072 | finished | 2 s | 1.6 GB | 949 MB | normal |  |
| pageNumbers scan_500MB @3072 | finished | 2.5 s | 1.3 GB | 837 MB | normal |  |
| pdfToWord scan_500MB @3072 | finished | 33.5 s | 1.9 GB | 1272 MB | normal |  |
| compress scan_10MB @4096 | finished | 2.9 s | 1.1 GB | 674 MB | normal | 10.2 MB → 831 KB (−92%) / 3 of 3 images recompressed |
| watermark scan_10MB @4096 | finished | 0.3 s | 0.7 GB | 194 MB | normal |  |
| merge scan_10MB @4096 | finished | 0.3 s | 0.7 GB | 190 MB | normal |  |
| rotate scan_10MB @4096 | finished | 0.3 s | 0.8 GB | 507 MB | normal |  |
| pageNumbers scan_10MB @4096 | finished | 0.4 s | 0.8 GB | 423 MB | normal |  |
| pdfToWord scan_10MB @4096 | finished | 0.9 s | 1.0 GB | 482 MB | normal |  |
| compress scan_50MB @4096 | finished | 9.5 s | 1.5 GB | 1092 MB | normal | 50.9 MB → 4.04 MB (−92%) / 15 of 15 images recompressed |
| watermark scan_50MB @4096 | finished | 0.5 s | 0.8 GB | 194 MB | normal |  |
| merge scan_50MB @4096 | finished | 0.3 s | 0.8 GB | 263 MB | normal |  |
| rotate scan_50MB @4096 | finished | 0.4 s | 1.4 GB | 814 MB | normal |  |
| pageNumbers scan_50MB @4096 | finished | 0.4 s | 0.6 GB | 194 MB | normal |  |
| pdfToWord scan_50MB @4096 | finished | 3 s | 1.3 GB | 627 MB | normal |  |
| compress scan_150MB @4096 | finished | 26.6 s | 1.6 GB | 1129 MB | normal | 148.8 MB → 11.7 MB (−92%) / 44 of 44 images recompressed |
| watermark scan_150MB @4096 | finished | 0.8 s | 0.9 GB | 369 MB | normal |  |
| merge scan_150MB @4096 | finished | 1 s | 0.9 GB | 552 MB | normal |  |
| rotate scan_150MB @4096 | finished | 1 s | 1.4 GB | 963 MB | normal |  |
| pageNumbers scan_150MB @4096 | finished | 0.9 s | 0.7 GB | 260 MB | normal |  |
| pdfToWord scan_150MB @4096 | finished | 7.7 s | 1.5 GB | 736 MB | normal |  |
| compress scan_500MB @4096 | finished | 91.4 s | 1.4 GB | 974 MB | normal | 486.7 MB → 38.4 MB (−92%) / 144 of 144 images recompressed |
| watermark scan_500MB @4096 | finished | 2 s | 1.0 GB | 371 MB | normal |  |
| merge scan_500MB @4096 | finished | 1.9 s | 0.9 GB | 581 MB | normal |  |
| rotate scan_500MB @4096 | finished | 2 s | 1.6 GB | 1348 MB | normal |  |
| pageNumbers scan_500MB @4096 | finished | 2 s | 1.0 GB | 479 MB | normal |  |
| pdfToWord scan_500MB @4096 | finished | 23.7 s | 1.7 GB | 1209 MB | normal |  |
| compress scan_10MB @8192 | finished | 2.9 s | 1.1 GB | 848 MB | normal | 10.2 MB → 831 KB (−92%) / 3 of 3 images recompressed |
| watermark scan_10MB @8192 | finished | 0.3 s | 0.6 GB | 200 MB | normal |  |
| merge scan_10MB @8192 | finished | 0.3 s | 0.7 GB | 192 MB | normal |  |
| rotate scan_10MB @8192 | finished | 0.1 s | 0.8 GB | 510 MB | normal |  |
| pageNumbers scan_10MB @8192 | finished | 0.2 s | 0.5 GB | 194 MB | normal |  |
| pdfToWord scan_10MB @8192 | finished | 0.9 s | 1.0 GB | 495 MB | normal |  |
| compress scan_50MB @8192 | finished | 9.6 s | 1.5 GB | 1053 MB | normal | 50.9 MB → 4.04 MB (−92%) / 15 of 15 images recompressed |
| watermark scan_50MB @8192 | finished | 0.5 s | 0.8 GB | 194 MB | normal |  |
| merge scan_50MB @8192 | finished | 0.3 s | 0.8 GB | 191 MB | normal |  |
| rotate scan_50MB @8192 | finished | 0.3 s | 1.1 GB | 478 MB | normal |  |
| pageNumbers scan_50MB @8192 | finished | 0.4 s | 0.6 GB | 194 MB | normal |  |
| pdfToWord scan_50MB @8192 | finished | 3 s | 1.3 GB | 588 MB | normal |  |
| compress scan_150MB @8192 | finished | 27.6 s | 1.4 GB | 1040 MB | normal | 148.8 MB → 11.7 MB (−92%) / 44 of 44 images recompressed |
| watermark scan_150MB @8192 | finished | 0.9 s | 0.9 GB | 383 MB | normal |  |
| merge scan_150MB @8192 | finished | 1 s | 0.8 GB | 390 MB | normal |  |
| rotate scan_150MB @8192 | finished | 1 s | 1.7 GB | 1358 MB | normal |  |
| pageNumbers scan_150MB @8192 | finished | 1 s | 1.0 GB | 402 MB | normal |  |
| pdfToWord scan_150MB @8192 | finished | 7.6 s | 1.6 GB | 916 MB | normal |  |
| compress scan_500MB @8192 | finished | 85.5 s | 1.5 GB | 1080 MB | normal | 486.7 MB → 38.4 MB (−92%) / 144 of 144 images recompressed |
| watermark scan_500MB @8192 | finished | 2 s | 1.1 GB | 435 MB | normal |  |
| merge scan_500MB @8192 | finished | 1.9 s | 0.8 GB | 529 MB | normal |  |
| rotate scan_500MB @8192 | finished | 2 s | 1.6 GB | 1339 MB | normal |  |
| pageNumbers scan_500MB @8192 | finished | 1.9 s | 0.9 GB | 247 MB | normal |  |
| pdfToWord scan_500MB @8192 | finished | 23.5 s | 1.7 GB | 1192 MB | normal |  |
| compress scan_10MB @none | finished | 2.9 s | 1.1 GB | 674 MB | normal | 10.2 MB → 831 KB (−92%) / 3 of 3 images recompressed |
| watermark scan_10MB @none | finished | 0.3 s | 0.6 GB | 200 MB | normal |  |
| merge scan_10MB @none | finished | 0.2 s | 0.5 GB | 191 MB | normal |  |
| rotate scan_10MB @none | finished | 0.1 s | 0.8 GB | 578 MB | normal |  |
| pageNumbers scan_10MB @none | finished | 0.2 s | 0.5 GB | 195 MB | normal |  |
| pdfToWord scan_10MB @none | finished | 0.9 s | 0.9 GB | 423 MB | normal |  |
| compress scan_50MB @none | finished | 10.6 s | 1.4 GB | 1127 MB | normal | 50.9 MB → 4.04 MB (−92%) / 15 of 15 images recompressed |
| watermark scan_50MB @none | finished | 0.4 s | 0.9 GB | 195 MB | normal |  |
| merge scan_50MB @none | finished | 0.3 s | 0.8 GB | 191 MB | normal |  |
| rotate scan_50MB @none | finished | 0.4 s | 1.1 GB | 528 MB | normal |  |
| pageNumbers scan_50MB @none | finished | 0.4 s | 0.6 GB | 195 MB | normal |  |
| pdfToWord scan_50MB @none | finished | 3 s | 1.4 GB | 1170 MB | normal |  |
| compress scan_150MB @none | finished | 26.6 s | 1.6 GB | 1241 MB | normal | 148.8 MB → 11.7 MB (−92%) / 44 of 44 images recompressed |
| watermark scan_150MB @none | finished | 1 s | 1.0 GB | 349 MB | normal |  |
| merge scan_150MB @none | finished | 1 s | 0.8 GB | 564 MB | normal |  |
| rotate scan_150MB @none | finished | 1 s | 1.6 GB | 1246 MB | normal |  |
| pageNumbers scan_150MB @none | finished | 0.9 s | 0.9 GB | 330 MB | normal |  |
| pdfToWord scan_150MB @none | finished | 7.6 s | 1.5 GB | 751 MB | normal |  |
| compress scan_500MB @none | finished | 87.1 s | 1.5 GB | 1086 MB | normal | 486.7 MB → 38.4 MB (−92%) / 144 of 144 images recompressed |
| watermark scan_500MB @none | finished | 1.9 s | 1.0 GB | 755 MB | normal |  |
| merge scan_500MB @none | finished | 2 s | 0.9 GB | 383 MB | normal |  |
| rotate scan_500MB @none | finished | 2 s | 1.4 GB | 1150 MB | normal |  |
| pageNumbers scan_500MB @none | finished | 1.9 s | 1.1 GB | 423 MB | normal |  |
| pdfToWord scan_500MB @none | finished | 23.2 s | 1.7 GB | 1170 MB | normal |  |

144 results: 121 finished, 23 slowed, 0 stopped, 0 other.

</details>

**C. Student files (56 runs): 43 finished, 13 slowed, 0 stopped.**

<details><summary>All 56 rows</summary>

| Test | Outcome | Time | Peak (app) | Peak (job) | Level reached | Note |
|---|---|---|---|---|---|---|
| merge scan_50MB.pdf +1 @624 | finished | 0.3 s | 0.7 GB | 254 MB | normal |  |
| split scan_50MB.pdf @624 | finished | 0.9 s | 0.6 GB | 194 MB | normal |  |
| organize journal_20p.pdf @624 | finished | 0.1 s | 0.6 GB | 313 MB | normal |  |
| rotate scan_50MB.pdf @624 | slowed | 0.3 s | 0.9 GB | 573 MB | high |  |
| crop scan_50MB.pdf @624 | finished | 0.4 s | 0.7 GB | 193 MB | normal |  |
| editPdf journal_20p.pdf @624 | slowed | 0.1 s | 0.7 GB | 480 MB | high |  |
| sign journal_20p.pdf @624 | finished | 0.1 s | 0.6 GB | 350 MB | normal |  |
| watermark scan_50MB.pdf @624 | finished | 0.4 s | 0.7 GB | 195 MB | normal |  |
| pageNumbers scan_50MB.pdf @624 | finished | 0.4 s | 0.6 GB | 195 MB | normal |  |
| redact journal_20p.pdf @624 | finished | 1.4 s | 0.8 GB | 318 MB | normal | 20 pages flattened; 0 left untouched. |
| compress scan_50MB.pdf @624 | slowed | 19.4 s | 1.1 GB | 697 MB | over | 50.9 MB → 4.04 MB (−92%) / 15 of 15 images recompressed |
| repair scan_50MB_cut90.pdf @624 | slowed | 2.4 s | 0.9 GB | 687 MB | over | Recovered 13 pages with their original text and graphics. 1 damaged section was skipped. |
| pdfToPdfa scan_50MB.pdf @624 | finished | 0.3 s | 0.5 GB | 190 MB | normal |  |
| protect scan_50MB.pdf @624 | finished | 0.4 s | 0.6 GB | 191 MB | normal |  |
| unlock scan_50MB_protected.pdf @624 | finished | 0.9 s | 0.6 GB | 393 MB | normal |  |
| pdfToWord journal_20p.pdf @624 | finished | 0.9 s | 0.7 GB | 301 MB | normal |  |
| pdfToWord scan_50MB.pdf @624 | slowed | 11.2 s | 1.1 GB | 894 MB | over |  |
| pdfToExcel journal_20p.pdf @624 | finished | 0.1 s | 0.5 GB | 302 MB | normal |  |
| pdfToPpt scan_50MB.pdf @624 | slowed | 13.3 s | 1.3 GB | 701 MB | over |  |
| pdfToMarkdown journal_20p.pdf @624 | finished | 0.9 s | 0.5 GB | 309 MB | normal |  |
| pdfToJpg scan_50MB.pdf @624 | slowed | 16.3 s | 1.3 GB | 753 MB | over | scan_50MB_pages.zip · 8.82 MB / Saving as scan_50MB_pages.zip in 5s |
| imageToPdf p00.jpg +29 @624 | finished | 0.3 s | 0.6 GB | 301 MB | normal |  |
| scanToPdf photo_48MP.jpg @624 | finished | 0.1 s | 0.8 GB | 317 MB | normal |  |
| wordToPdf big.docx @624 | finished | 1.9 s | 0.7 GB | 238 MB | normal | 107 pages |
| excelToPdf big_10k_rows.xlsx @624 | slowed | 3.4 s | 0.7 GB | 551 MB | high | 371 pages |
| pptToPdf big_150_slides.pptx @624 | finished | 0.8 s | 0.6 GB | 195 MB | normal | 150 pages |
| htmlToPdf long.html @624 | slowed | 2.9 s | 1.3 GB | 436 MB | normal | 232 pages |
| merge scan_50MB.pdf +1 @1024 | finished | 0.3 s | 0.7 GB | 190 MB | normal |  |
| split scan_50MB.pdf @1024 | finished | 0.9 s | 0.6 GB | 195 MB | normal |  |
| organize journal_20p.pdf @1024 | finished | 0.2 s | 0.6 GB | 333 MB | normal |  |
| rotate scan_50MB.pdf @1024 | finished | 0.3 s | 1.0 GB | 606 MB | normal |  |
| crop scan_50MB.pdf @1024 | finished | 0.3 s | 0.5 GB | 195 MB | normal |  |
| editPdf journal_20p.pdf @1024 | finished | 0.1 s | 0.7 GB | 475 MB | normal |  |
| sign journal_20p.pdf @1024 | finished | 0.1 s | 0.6 GB | 353 MB | normal |  |
| watermark scan_50MB.pdf @1024 | finished | 0.4 s | 0.7 GB | 193 MB | normal |  |
| pageNumbers scan_50MB.pdf @1024 | finished | 0.4 s | 0.6 GB | 194 MB | normal |  |
| redact journal_20p.pdf @1024 | finished | 1.4 s | 0.7 GB | 317 MB | normal | 20 pages flattened; 0 left untouched. |
| compress scan_50MB.pdf @1024 | slowed | 10.6 s | 1.4 GB | 1089 MB | over | 50.9 MB → 4.04 MB (−92%) / 15 of 15 images recompressed |
| repair scan_50MB_cut90.pdf @1024 | finished | 1.9 s | 0.8 GB | 194 MB | normal | Recovered 13 pages with their original text and graphics. 1 damaged section was skipped. |
| pdfToPdfa scan_50MB.pdf @1024 | finished | 0.3 s | 0.6 GB | 191 MB | normal |  |
| protect scan_50MB.pdf @1024 | finished | 0.4 s | 0.6 GB | 189 MB | normal |  |
| unlock scan_50MB_protected.pdf @1024 | finished | 0.9 s | 0.6 GB | 368 MB | normal |  |
| pdfToWord journal_20p.pdf @1024 | finished | 0.9 s | 0.7 GB | 310 MB | normal |  |
| pdfToWord scan_50MB.pdf @1024 | slowed | 10.6 s | 1.1 GB | 814 MB | high |  |
| pdfToExcel journal_20p.pdf @1024 | finished | 0.1 s | 0.5 GB | 317 MB | normal |  |
| pdfToPpt scan_50MB.pdf @1024 | slowed | 10.6 s | 1.4 GB | 893 MB | high |  |
| pdfToMarkdown journal_20p.pdf @1024 | finished | 0.9 s | 0.5 GB | 304 MB | normal |  |
| pdfToJpg scan_50MB.pdf @1024 | finished | 9.1 s | 1.2 GB | 693 MB | normal | scan_50MB_pages.zip · 8.82 MB / Saving as scan_50MB_pages.zip in 5s |
| imageToPdf p00.jpg +29 @1024 | finished | 0.2 s | 0.5 GB | 266 MB | normal |  |
| scanToPdf photo_48MP.jpg @1024 | finished | 0.1 s | 0.8 GB | 317 MB | normal |  |
| wordToPdf big.docx @1024 | finished | 1.9 s | 0.8 GB | 575 MB | normal | 107 pages |
| excelToPdf big_10k_rows.xlsx @1024 | finished | 3.4 s | 0.8 GB | 255 MB | normal | 371 pages |
| pptToPdf big_150_slides.pptx @1024 | finished | 0.8 s | 0.6 GB | 200 MB | normal | 150 pages |
| htmlToPdf long.html @1024 | slowed | 3.7 s | 1.3 GB | 1092 MB | over | 232 pages |
| compare journal_10p vs journal_20p @624 | finished | 0 s | 0.5 GB | 274 MB | normal |  |
| compare journal_10p vs journal_20p @1024 | finished | 0 s | 0.5 GB | 272 MB | normal |  |

56 results: 43 finished, 13 slowed, 0 stopped, 0 other.

</details>

**D. Busy Windows.** The first run used the old absolute defaults (`free=8192,2400,1800`). They were written for a 16 GB PC: on this 32 GB laptop the reserve is 3.2 GB, so "2400/1800 free" was *below* the reserve, a much harsher case than intended. `busy.mjs` now takes `reserve+N`, and was re-run with the 16 GB-equivalent margins (reserve+762, reserve+162).

Re-run, matched to this PC (`free=8192,3978,3378 stop=no`, i.e. reserve+762 and reserve+162):

| Test | Outcome | Time | Peak (app) | Peak (job) | Level reached | Note |
|---|---|---|---|---|---|---|
| compress scan_150MB.pdf · Windows leaves 8192 MB free | finished | 33.7 s | 1.5 GB | 1124 MB | normal | 148.8 MB → 11.7 MB (−92%) / 44 of 44 images recompressed |
| pdfToWord scan_150MB.pdf · Windows leaves 8192 MB free | finished | 7.7 s | 1.6 GB | 860 MB | normal |  |
| watermark scan_500MB.pdf · Windows leaves 8192 MB free | finished | 2.2 s | 1.0 GB | 438 MB | normal |  |
| compress scan_150MB.pdf · Windows leaves 3978 MB free | slowed | 38.4 s | 1.3 GB | 964 MB | over | 148.8 MB → 11.7 MB (−92%) / 44 of 44 images recompressed |
| pdfToWord scan_150MB.pdf · Windows leaves 3978 MB free | slowed | 29.7 s | 1.2 GB | 828 MB | over |  |
| watermark scan_500MB.pdf · Windows leaves 3978 MB free | finished | 1.9 s | 1.1 GB | 416 MB | normal |  |
| compress scan_150MB.pdf · Windows leaves 3378 MB free | stopped | 10.1 s | 1.1 GB | 643 MB | critical | Stopped to protect this PC: Windows is almost out of memory (2.9 GB free of 31.4 GB). Nothing was changed. Close other programs and try again. |
| pdfToWord scan_150MB.pdf · Windows leaves 3378 MB free | slowed | 39 s | 1.3 GB | 1072 MB | over |  |
| watermark scan_500MB.pdf · Windows leaves 3378 MB free | slowed | 4.1 s | 1.1 GB | 726 MB | over |  |

9 results: 4 finished, 4 slowed, 1 stopped, 0 other.

First run, old absolute defaults (below this PC's reserve):

| Test | Outcome | Time | Peak (app) | Peak (job) | Level reached | Note |
|---|---|---|---|---|---|---|
| compress scan_150MB.pdf · Windows leaves 8192 MB free | finished | 25 s | 1.6 GB | 1227 MB | normal | 148.8 MB → 11.7 MB (−92%) / 44 of 44 images recompressed |
| pdfToWord scan_150MB.pdf · Windows leaves 8192 MB free | finished | 7.7 s | 1.5 GB | 913 MB | normal |  |
| watermark scan_500MB.pdf · Windows leaves 8192 MB free | finished | 2 s | 1.0 GB | 414 MB | normal |  |
| compress scan_150MB.pdf · Windows leaves 2400 MB free | stopped | 9.6 s | 1.0 GB | 546 MB | critical | Stopped to protect this PC: Windows is almost out of memory (2.0 GB free of 31.4 GB). Nothing was changed. Close other programs and try again. |
| pdfToWord scan_150MB.pdf · Windows leaves 2400 MB free | harness-error |  | 1.3 GB | 1086 MB | critical | page.waitForFunction: Page crashed |
| watermark scan_500MB.pdf · Windows leaves 2400 MB free | slowed | 4.5 s | 1.1 GB | 759 MB | over |  |
| compress scan_150MB.pdf · Windows leaves 1800 MB free | stopped | 1.9 s | 1.0 GB | 544 MB | critical | Stopped to protect this PC: Windows is almost out of memory (1.3 GB free of 31.4 GB). Nothing was changed. Close other programs and try again. |
| pdfToWord scan_150MB.pdf · Windows leaves 1800 MB free | harness-error |  | 1.0 GB | 677 MB | critical | page.waitForFunction: Page crashed |
| watermark scan_500MB.pdf · Windows leaves 1800 MB free | stopped | 0.9 s | 1.0 GB | 270 MB | critical | Stopped to protect this PC: Windows is almost out of memory (1.5 GB free of 31.4 GB). Nothing was changed. Close other programs and try again. |
| pdfToWord scan_500MB.pdf · Windows leaves reserve+80 MB free | slowed | 263.5 s | 1.6 GB | 1359 MB | over |  |

10 results: 3 finished, 2 slowed, 3 stopped, 2 other.

**E. Last resorts:** all as expected.

| Test | Outcome | Time | Peak (app) | Peak (job) | Level reached | Note |
|---|---|---|---|---|---|---|
| last resort: 300 MP PNG → PDF @1024 | stopped | 0.4 s | 0.4 GB | 179 MB | normal | huge_300MP.png: Stopped to protect this PC: part of this job needs more memory than IHatePDF may use here (1.0 GB of 31.4 GB RAM), even working in small pieces. Nothing was changed. Close other programs and try again, or |
|   … app still usable afterwards | yes |  |  |  |  |  |
| last resort: Windows down to 300 MB free during compress 150 MB | stopped | 2.4 s | 1.1 GB | 718 MB | critical | Stopped to protect this PC: Windows is almost out of memory (0.3 GB free of 31.4 GB). Nothing was changed. Close other programs and try again. |
|   … app still usable afterwards | yes |  |  |  |  |  |
| last resort: stuck window grabbing memory @1024 | restarted | 1.5 s |  |  |  | notice shown |

5 results: 0 finished, 0 slowed, 2 stopped, 3 other.

**F.** Not run (needs Dev at the laptop).

**G. Thumbnails:** 7.4 s at 1024 vs 0.9 s unset for the first 12 thumbnails of the 50 MB scan. At 1024 pdf.js uses its own JPEG decoder (much less memory, much slower). On a slower lab CPU expect roughly twice that. Acceptable (tools themselves aren't slowed), but noticeable: it's the first thing a student sees after opening a big scan.

**H. Text:** Watermark "गोपनीय" and "机密", and Edit PDF with Hindi and with Chinese, all saved with embedded Noto Sans Devanagari / Noto Sans SC subsets; text extracts correctly; Edge's PDF viewer renders them with correctly joined Devanagari (e.g. स्ता in दस्तावेज़). Adobe Reader: **not installed, not checked**. PDF→Word on a heading edited to "गोपनीय दस्तावेज़ 机密文件": both scripts in the .docx; Word shows them (falls back to Nirmala UI for Hindi and MS Mincho for the Chinese characters). PDF→Word on the *rotated* margin note drops it, in any language (see Known limits).

**Network:** No internet requests on 1.3.1-beta.3 (a separate run recording every request the app made: Compress 50 MB scan, Watermark 150 MB scan, a small job).

**I.** `npm test`: 17/17 + 34/34. `all-tools.mjs` in Edge: 29/29 (after the harness fixes below; before them 24/29 on missing input files).

**Harness changes this session (no app code changed):**
- `scripts/e2e/harness.mjs`: used a hard-coded Linux Chromium path; now uses the installed Edge on Windows (`CHROMIUM_PATH` overrides).
- `scripts/e2e/make-e2e-fixtures.mjs` (new): generates `test-fixtures/misc/{photo1.jpg,photo2.png,book.xlsx,page.html}` and `big/scan_photos.pdf`, which `all-tools.mjs` needs and nothing in the repo created.
- `scripts/e2e/memory/busy.mjs`: `free=` accepts `reserve+N`; defaults are reserve-relative so the test means the same on any PC.
- `scripts/e2e/memory/harness.mjs`: a window the fail-safe reloads is recorded as `restarted` (or `crashed` for a real crash) instead of `harness-error: Page crashed`.
- `scripts/e2e/memory/windows-checks.mjs` (new): tests A, G, H.

## Known limits

- **Reserve vs emergency threshold on big PCs:** the emergency stop is "under 5% free" (1.6 GB here) but the reserve is 10% (3.2 GB). On a 32 GB PC, "reserve+80 MB free" never reaches the emergency threshold, so busy.mjs's final case *finishes* (slowly, 264 s) instead of stopping. On 16 GB and smaller the two are closer. Not a bug; the expectation in the table assumes a 16 GB PC.
- **PDF→Word drops rotated text** (e.g. a sideways margin note), in any language.
- The browser-only e2e helpers `renderCompare.mjs`, `screenshots.mjs`, `snapshot.mjs` still hard-code the Linux Chromium path (not used by tests A–I).
- Harness timings include launching the app; the "Time" column is from the click to the result.

## Open issues

| # | Found | Issue | Status |
|---|---|---|---|
| 1 | 2026-09-30, beta.3 | **Compress stops when Windows is within ~160 MB of the reserve** (busy.mjs reserve+162: "Stopped … Windows is almost out of memory (2.9 GB free)" after 10 s). PDF→Word and Watermark finish in the same case. Likely cause: on Windows a paused job's working set doesn't fall after GC within the 8 s grace period (freed memory stays in the working set until Windows trims it), so "still over the limit after 8 s" fires. On Linux RSS drops, so the Linux run passed. Options: measure private bytes instead of working set on Windows, trim working sets when pausing, or extend the grace period when Windows isn't actually low. | Open: waiting for Dev's decision |
| 2 | 2026-09-30, beta.3 | **PDF→Word window reloaded instead of a clean stop** when Windows is below the reserve (first D run, 2400/1800 on 32 GB): the page couldn't free memory within 3 s of the critical report, so the watchdog's last resort reloaded it. Rendering pages for the Word file happens on the page itself. Designed backstop, but the user gets "restarted" instead of the explanation. | Open, low |
| 3 | 2026-09-30, beta.3 | Thumbnails at a 1 GB budget are ~8× slower (pdf.js's own JPEG decoder). | Open, low: consider decoding thumbnails at a lower resolution instead |
