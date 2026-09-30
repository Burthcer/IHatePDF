# IHatePDF v1.3.1-beta.3

**Pre-release for testing on real Windows PCs.** The stable version is still [v1.3.0](https://github.com/Burthcer/IHatePDF/releases/tag/v1.3.0).

The memory fail-safe now slows down instead of stopping. On a 4 GB lab PC, 1.3.0 stopped even a 10 MB scan; 1.3.1 finishes normal student files on every tool, and big scans too, taking longer when it has to.

**New in beta.3:** a window that starts grabbing memory right after the app opens is now caught as fast as any other (about 1.5 s); and the memory tests are in the repository (`scripts/e2e/memory/`).

**New in beta.2:** the fail-safe also makes room for Windows. When Windows and other programs are using most of the memory, IHatePDF lowers its own limit, so jobs slow down and pause early instead of running until Windows is almost out.

## Install

1. Download **IHatePDF-Setup.exe** below, under *Assets*.
2. Run it. If Windows says *"Windows protected your PC"*, click **More info → Run anyway**. The installer isn't code-signed.
3. It replaces 1.3.0 (or any earlier version) in place.

## What changed

**Only the job's memory counts.** IHatePDF itself uses 0.5–0.9 GB while idle on Windows. In 1.3.0 that counted against the memory budget, so on a 4 GB PC (1 GB budget) almost every job was stopped at once. Now the fail-safe measures only what the running job adds.

**Slower, not stopped.** As a job nears its budget:

| Job's memory | What happens |
|---|---|
| Under 70% of the budget | Normal speed |
| 70% or more | Works in smaller pieces; the app shows **"Low on memory: taking longer"** |
| Over the budget | Pauses at the next page or image, frees memory, and carries on |

**Room for Windows (beta.2).** The budget is fixed from the PC's RAM (1 GB on 4 GB, 4 GB on 8 GB, 8 GB on 16 GB, 16 GB on 32 GB+). But a job may only use as much as keeps a reserve free for Windows: 10% of RAM, at least 1 GB. On a 16 GB PC where Windows uses 8 GB, a job's limit is about 6.4 GB instead of 8 GB; with only 2 GB free it's about 0.4 GB, and never below 0.25 GB. The steps above then start earlier, and the message says **"Windows is short of memory, so IHatePDF is working in smaller pieces to leave it room"**.

**Busy moments never lower quality (beta.2).** Which images Compress re-encodes, how large pages are rendered for JPG and Word, and which images are refused depend on the PC's budget only. A busy moment makes a job slower, never worse.

**Stopping is the last resort,** with the same clear message and the app still usable:
- Windows itself is almost out of memory (under 5% of RAM free), or has so little free that the job can't fit even after pausing, or
- one piece of the job needs more than the budget even after pausing (for example a single enormous image).

**Less memory for scanned PDFs.**
- Page previews pause while a job runs.
- On 4 GB PCs, pages are decoded in a leaner way: the browser's own decoder kept every decoded 300 dpi page (35 MB each) in memory.
- Memory the job has finished with is released straight away when memory is tight.

## Measured

Real 300 dpi scans (JPEG, ~3.6 MB a page) in the desktop app, with the budget forced to that of a 4 GB PC (1 GB) and, to allow for Windows' higher idle memory, 400 MB less (624 MB):

| Tool | 10 / 50 / 150 / 500 MB scan, 624 MB budget | 500 MB scan, 1 GB budget |
|---|---|---|
| Compress | all finished (4 s / 12 s / 32 s / 107 s) | finished, 100 s |
| Watermark | all finished (1–5 s) | finished, 5 s |
| Merge (+ a 20-page journal) | all finished (0–4 s) | finished, 4 s |
| Rotate | all finished (0–4 s) | finished, 4 s |
| Page numbers | all finished (1–4 s) | finished, 4 s |
| PDF → Word | all finished; the 500 MB scan slowed down and paused, 123 s | finished, 110 s |

- **Every tool** finished a 50 MB scan or a 10–20 page journal at both a 624 MB and a 1 GB budget (60 of 60).
- **Stopped only when it had to:**
  - A single 300-megapixel image is refused before anything starts.
  - When Windows reports almost no free memory, the running job stops in 3 s with *"Windows is almost out of memory"*.
  - A window stuck grabbing memory is restarted in 1.5 s.
  - After each of these, the app carried on working normally.

## Known limits

Same as 1.3.0: see the [1.3.0 release notes](https://github.com/Burthcer/IHatePDF/releases/tag/v1.3.0).

PDF → Word builds the Word file in one piece at the end. At the tightest budget tested (a 4 GB PC with a busy Windows), a 500 MB, 138-page scan is borderline: it finished in two runs out of three and was stopped with the message in the third. At a 4 GB PC's normal budget it finishes.

On 4 GB PCs, page previews of scanned PDFs draw more slowly than on bigger PCs (the leaner decoder).
