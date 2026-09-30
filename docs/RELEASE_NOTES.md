# IHatePDF v1.3.1

The memory fail-safe now slows down instead of stopping. On a 4 GB lab PC, 1.3.0 stopped even a 10 MB scan; 1.3.1 finishes normal student files on every tool, and big scans too, taking longer when it has to. Tested on Linux and on a real Windows 11 PC: 200 of 200 tool runs finished at the budgets of 4, 6, 8 and 16 GB PCs.

## Install

1. Download **IHatePDF-Setup.exe** below, under *Assets*.
2. Run it. If Windows says *"Windows protected your PC"*, click **More info → Run anyway**. The installer isn't code-signed.
3. It replaces 1.3.0 (or any earlier version) in place: one IHatePDF in *Settings → Apps*, shortcuts kept.

## What changed

**Only the job's memory counts.** IHatePDF itself uses 0.4–0.9 GB while idle on Windows. In 1.3.0 that counted against the memory budget, so on a 4 GB PC (1 GB budget) almost every job was stopped at once. Now the fail-safe measures only what the running job adds.

**Slower, not stopped.** As a job nears its limit:

| Job's memory | What happens |
|---|---|
| Under 70% of the limit | Normal speed |
| 70% or more | Works in smaller pieces; the app shows **"Low on memory: taking longer"** |
| Over the limit | Pauses at the next page or image, frees memory, and carries on |

**Room for Windows.** The budget is fixed from the PC's RAM (1 GB on 4 GB, 3 GB on 6 GB, 4 GB on 8 GB, 8 GB on 16 GB, 16 GB on 32 GB+). But a job may only use as much as keeps a reserve free for Windows: 10% of RAM, at least 1 GB. On a 16 GB PC where Windows uses 8 GB, a job's limit is about 6.4 GB instead of 8 GB; with only 2 GB free it's about 0.4 GB, and never below 0.25 GB. The steps above then start earlier, and the message says **"Windows is short of memory, so IHatePDF is working in smaller pieces to leave it room"**.

**Busy moments never lower quality.** Which images Compress re-encodes, how large pages are rendered for JPG and Word, and which images are refused depend on the PC's budget only. A busy moment makes a job slower, never worse.

**Stopping is the last resort,** with the same clear message and the app still usable:
- Windows itself is almost out of memory (under 5% of RAM free), or has so little free that the job can't fit even after pausing, or
- one piece of the job needs more than the budget even after pausing (for example a single enormous image).

**Less memory for scanned PDFs.**
- Page previews pause while a job runs.
- On 4 GB PCs, pages are decoded in a leaner way: the browser's own decoder kept every decoded 300 dpi page (35 MB each) in memory.
- Memory the job has finished with is released straight away when memory is tight.

**Also:** a window that starts grabbing memory right after the app opens is caught as fast as any other (about 1.5 s), and the memory tests are in the repository (`scripts/e2e/memory/`, Windows log in `docs/testing/WINDOWS_TESTS.md`).

## Measured on Windows

Windows 11 (build 26200), Intel Core Ultra 9 185H, 32 GB RAM, the installed app driven by the repository's memory tests. Scans are 300 dpi JPEG pages (~3.4 MB a page): 10, 50, 150 and 500 MB (144 pages). Smaller PCs are simulated by forcing their budget; 624 MB is a 4 GB PC with 400 MB less, for Windows' higher idle memory.

**Every tool at every budget:** Compress, Watermark, Merge, Rotate, Page numbers and PDF → Word on the four scans (144 runs), and every tool on a normal student file at 624 MB and 1 GB (56 runs).

| Budget (PC) | Finished (scans + student files) | Finished, slowed down | Stopped |
|---|---|---|---|
| 624 MB (4 GB, tight) | 10 + 19 | 14 + 9 | 0 |
| 1 GB (4 GB) | 15 + 24 | 9 + 4 | 0 |
| 3 GB (6 GB) | 24 | 0 | 0 |
| 4 GB (8 GB) | 24 | 0 | 0 |
| 8 GB (16 GB) | 24 | 0 | 0 |
| 16 GB (this 32 GB PC) | 24 | 0 | 0 |

Every Compress recompressed every image (3/3, 15/15, 44/44, 144/144).

**Compress, and the change from 1.3.0 on the same PC:**

| Scan | 4 GB PC, 1.3.0 | 4 GB PC, 1.3.1 | 6 GB PC | 8 GB PC |
|---|---|---|---|---|
| 10 MB | stopped | 831 KB, 3 s | 831 KB, 3 s | 831 KB, 3 s |
| 50 MB | stopped | 4.0 MB, 11 s | 4.0 MB, 10 s | 4.0 MB, 10 s |
| 150 MB | stopped | 11.7 MB, 31 s | 11.7 MB, 26 s | 11.7 MB, 27 s |
| 500 MB | stopped | 38.4 MB, 121 s | 38.4 MB, 108 s | 38.4 MB, 91 s |

Watermark on the 500 MB scan: stopped in 1.3.0 at a 1 GB budget; 3 s in 1.3.1.

**Windows busy with other programs** (this PC's 16 GB budget; free memory shrinks as the job grows). Free memory is given above the 3.2 GB reserve, the same margins as 2,400 and 1,800 MB free on a 16 GB PC:

| Windows leaves free | Compress 150 MB | PDF → Word 150 MB | Watermark 500 MB |
|---|---|---|---|
| 8 GB | finished, 34 s, 44/44 images | finished, 8 s | finished, 2 s |
| reserve + 762 MB | slowed, 38 s, 44/44 images | slowed, 30 s | finished, 2 s |
| reserve + 162 MB | **stopped** after 10 s: "Windows is almost out of memory" | slowed, 39 s | slowed, 4 s |

**Last resorts:** a 300-megapixel image refused at once; Windows down to 300 MB free stopped the running job in 2.4 s; a window stuck grabbing memory restarted in 1.5 s with a notice. After each, the next job worked normally.

**Also on Windows:** the app idles at 0.4 GB on its home screen (1.4 GB with a 500 MB scan open in Rotate). The first 12 page previews of a 50 MB scan take 7.4 s on a 4 GB PC and 0.9 s on bigger PCs. Hindi and Chinese text in Watermark and Edit PDF show correctly in Edge and, after PDF → Word, in Word. No internet requests. `npm test` 17/17 + 34/34, and every tool through the browser 29/29.

## Measured on Linux

Same kind of scans in the desktop app on a 16 GB Linux PC, with the budget of a 4 GB PC (1 GB) and 400 MB less (624 MB):

| Tool | 10 / 50 / 150 / 500 MB scan, 624 MB budget | 500 MB scan, 1 GB budget |
|---|---|---|
| Compress | all finished (4 s / 12 s / 32 s / 107 s) | finished, 100 s |
| Watermark | all finished (1–5 s) | finished, 5 s |
| Merge (+ a 20-page journal) | all finished (0–4 s) | finished, 4 s |
| Rotate | all finished (0–4 s) | finished, 4 s |
| Page numbers | all finished (1–4 s) | finished, 4 s |
| PDF → Word | all finished; the 500 MB scan slowed down and paused, 123 s | finished, 110 s |

- **Every tool** finished a 50 MB scan or a 10–20 page journal at both a 624 MB and a 1 GB budget (60 of 60).
- **Stopped only when it had to:** a single 300-megapixel image is refused before anything starts; when Windows reports almost no free memory, the running job stops in 3 s; a window stuck grabbing memory is restarted in 1.5 s. After each, the app carried on working normally.

## Known limits

- **Compress on a PC that's almost full.** When Windows is within about 160 MB of the reserve it keeps free, Compress can stop with *"Windows is almost out of memory"* instead of slowing down (other tools slow down and finish). Nothing crashes; closing other programs lets it run.
- **PDF → Word** builds the Word file in one piece at the end. If Windows is already below its reserve, the window may be restarted (with a notice) instead of showing the stop message. It also leaves out sideways (rotated) text.
- **Page previews** of scanned PDFs draw more slowly on 4 GB PCs (the leaner decoder). The tools themselves aren't slowed.
- Everything else as in 1.3.0: see the [1.3.0 release notes](https://github.com/Burthcer/IHatePDF/releases/tag/v1.3.0).
