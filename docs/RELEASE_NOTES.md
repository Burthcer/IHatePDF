# IHatePDF v1.3.1-beta

**Pre-release for testing on real Windows PCs.** The stable version is still [v1.3.0](https://github.com/Burthcer/IHatePDF/releases/tag/v1.3.0).

The memory fail-safe now slows down instead of stopping. On a 4 GB lab PC, 1.3.0 stopped even a 10 MB scan; 1.3.1 finishes normal student files on every tool, and big scans too, taking longer when it has to.

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

**Stopping is the last resort,** with the same clear message and the app still usable:
- Windows itself is almost out of memory, or
- one piece of the job needs more than the budget even after pausing (for example a single enormous image).

**Less memory for scanned PDFs.**
- Page previews pause while a job runs.
- On 4 GB PCs, pages are decoded in a leaner way: the browser's own decoder kept every decoded 300 dpi page (35 MB each) in memory.
- Memory the job has finished with is released straight away when memory is tight.

## Measured

MEASURED_TABLE

## Known limits

Same as 1.3.0: see the [1.3.0 release notes](https://github.com/Burthcer/IHatePDF/releases/tag/v1.3.0).

On 4 GB PCs, page previews of scanned PDFs draw more slowly than on bigger PCs (the leaner decoder).
