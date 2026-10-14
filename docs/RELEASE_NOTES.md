# IHatePDF v1.4.0

A **local usage log** (so a lab can measure how reliable and how heavy the app really is), **pictures in Word documents now survive Word → PDF**, **screenshots stay sharp when compressed**, and a clear message for files too big to preview.

## Install

1. Download **IHatePDF-Setup.exe** below, under *Assets*.
2. Run it. If Windows says *"Windows protected your PC"*, click **More info → Run anyway**. The installer isn't code-signed.
3. It replaces 1.3.x (or any earlier version) in place.

## Usage log

The app now keeps a small log **on the PC** of what it did: tool, sizes, time, success or error, memory and CPU, temp files. It is **never uploaded**, holds **no file names and nothing from your documents**, is capped at **15 MB**, and can be switched off in the footer or by the lab. Full list of what it records, how to point it at a shared drive (for Deep Freeze labs), and the summary tool: [docs/USAGE_LOG.md](USAGE_LOG.md).

- **Every job** is logged with its outcome (`ok`, `error`, `stopped` by the memory fail-safe, `cancelled`), time, input and output size, and the app's peak RAM and CPU (and the whole PC's).
- **Temp files** are counted when created and deleted, and checked at quit and at the next start: "left after clean-up" must be 0.
- **Usage:** anonymous PC and user ids (hashes), launches per day, tools opened.
- **`node scripts/log-summary.mjs <folder>`** turns the logs into the tables for a report: success rate overall and per tool, error classes, median and 95th-percentile times, RAM and CPU, temp-file checks, and the log's growth per day.
- Tested end to end on the real app (21 checks), including: no file name or path anywhere in the log, the 15 MB cap by rotation, the off switch, and the error classes (a damaged file is logged as `damaged-file`).

## Word → PDF keeps pictures

Before, pictures in a .docx were **silently dropped**: a Word file with screenshots became a PDF of text only. Now PNG and JPEG pictures (inline or floating, and old-style ones) are placed in the PDF at the size Word gave them, scaled down only if wider than the page, with their original pixels (nothing is re-compressed). A real Word file with a 1385 × 779 screenshot and a 1384 × 922 photo now comes out with both. Pictures inside table cells are still left out.

## Compress: screenshots and charts stay sharp

Compress used to shrink every picture the same way. A screenshot of a program, or a chart, pasted into Word is shown scaled down, so "150 dpi" cut its pixels roughly in half and the text in it went soft. Now the compressor recognises such pictures (mostly flat colour with sharp edges, not a full-page scan) and gives them more resolution and quality than photos at the same setting, and stores them losslessly when that is smaller than a JPEG. Measured on a 1920 × 1080 screenshot pasted at 16 cm (how much of the original's edge sharpness is left):

| Setting | Before | Now |
|---|---|---|
| Light | 100% | 100% |
| Balanced | 44% (resized to 945 × 531) | **100%** (kept as it was: it can't be made smaller without softening it) |
| Smallest | 34% | 43% |
| Custom, 100 KB | 39% | 41% |

A chart at Balanced went from 81% to 100%. Photos and full-page scans are compressed as before (a 300 dpi scanned text page at Balanced: 220 KB, the same as before). **Custom size** now says so when the target forces the pictures below 100 dpi: *"At this size small text inside pictures may be hard to read."*

## Files over 2 GB

The app's page engine can't hold a 2 GB block of memory, so **page previews can't open files over 2 GB** (Rotate, Organize, Crop, Split, Edit PDF, Sign, Redact, PDF → JPG: every tool that shows pages). Before, those tools showed "Loading pages…" forever. Now a message explains: *"This PDF is 5.0 GB. Page previews work up to 2 GB. You can still use Merge, Compress, Watermark, Page numbers, Protect and PDF/A on it, or split it into smaller parts first."* Those tools do work on a 5 GB file, measured on Windows (1,436 scanned pages, 5.0 GB):

| Tool | Time | Most memory used by the app |
|---|---|---|
| Watermark | 86 s | 924 MB |
| Page numbers | 56 s | 1.0 GB |
| Merge (+ 20 pages) | 65 s | 1.0 GB |
| Protect (AES-256) | 62 s | 990 MB |
| PDF/A | 71 s | 983 MB |

## Also

- The memory tests and the Windows test log (`scripts/e2e/memory/`, `docs/testing/WINDOWS_TESTS.md`) now include `usagelog.mjs`, `stress.mjs` (5 GB and 10,000-page files) and `quality.mjs` (picture quality, scored by `quality_score.py`).
- 85 automated checks (17 + 34 + 5 + 29).

## Known limits

- Previews and the tools that need them don't open files over 2 GB (above).
- Pictures in Word table cells are not carried into the PDF; Word's EMF/WMF pictures are left out.
- PDF → Word leaves out sideways (rotated) text and can misplace images inside tables or multi-column pages.
- Compress can stop with *"Windows is almost out of memory"* when Windows is within ~160 MB of the memory it keeps free (other tools slow down and finish).
- Scanned pages have no text (no OCR); signatures are visible, not certificate-based.
- Earlier limits: see the [1.3.1 release notes](https://github.com/Burthcer/IHatePDF/releases/tag/v1.3.1).
