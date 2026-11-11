# IHatePDF v2.0.0

The desktop app is rebuilt on **Tauri** with a **Rust core**. Same screens and tools; a much smaller installer, a faster start, and the heaviest tools moved off the page into Rust.

## Install

1. Download **IHatePDF-Setup.exe** below, under *Assets* (about 24 MB, was 130 MB).
2. Run it. If Windows says *"Windows protected your PC"*, click **More info → Run anyway**. The installer isn't code-signed.
3. It installs for your Windows account only (no administrator permission) and does **not** replace 1.x: uninstall 1.x first from *Settings → Apps*. Your saved files are never touched. It needs Microsoft Edge WebView2, which is part of Windows 10 and 11.

## What changed

| | 1.4.0 | 2.0.0 |
|---|---|---|
| Installer | 130 MB | **24 MB** |
| Launch to home screen (median of 3) | 1.19 s | **0.91 s** |
| Idle memory, all app processes (median) | 408 MB | 423 MB |
| Compress, 10 MB scan, click to result | 2.3 s | **0.8 s** |
| Compress, peak extra memory, same file | +706 MB | **+130 MB** |
| Compress, photo / 4 duplicate images | 313 / 393 ms | **91 / 142 ms** |

Idle memory is about the same because the page itself (the same React app) dominates it; what drops is the memory tools use while they work.

**In Rust now:** Compress, Merge, Split, Organize pages, Rotate, Crop, Images to PDF (and Scan to PDF), PDF to JPG/PNG, Redact, Watermark, Page numbers, Sign, the page count when a file is opened, and the page thumbnails every page tool shows (PDFium draws pages; pdf.js is no longer loaded for them). The memory fail-safe also runs in Rust again. Each one falls back to the 1.4.0 engine for anything it can't handle, so a tool never does worse than before.

**Still on the 1.4.0 engines (inside the new app):** Edit PDF, Forms, Repair, PDF/A, Protect, Unlock, Compare, every Word/Excel/PowerPoint/HTML conversion, and PDF to Word/Excel/PowerPoint/Markdown. Watermark and Page numbers fall back to the 1.4.0 engine for non-Western text. These move to Rust over the 2.x releases where it pays off.

**Not in 2.0.0:** Share to phone and the local usage log. Both are in 1.4.0 and return in later 2.x releases.

## Compress quality

Measured on the same pictures with both engines (SSIM against the original, higher is better):

| Picture, setting | 1.4.0 | 2.0.0 |
|---|---|---|
| Screenshot, Light / Balanced | exact | exact |
| Screenshot, Smallest | 0.904 | 0.914 |
| Chart, Smallest (edge sharpness kept) | 76% | 91% |
| Photo, Light / Balanced / Smallest | 0.968 / 0.966 / 0.963 | 0.968 / 0.966 / 0.962 |
| Scanned text, Light / Balanced / Smallest | 0.973 / 0.941 / 0.866 | 0.972 / 0.939 / 0.868 |

A Word file with a pasted screenshot and a photo, converted with Word to PDF and then compressed, keeps the screenshot exact at Light and Balanced.

Images the Rust engine can't decode safely (JPEG 2000, CMYK, Lab/Separation colour, odd /Decode arrays) and files over 1 GB go to the 1.4.0 engine.

## How it was tested

- 27 of the 28 tools driven end to end in the real app (`scripts/e2e/all-tools.mjs` with `E2E_CDP=http://127.0.0.1:9222`); the 28th, Compress, was run from its own script because the 44 MB input is over the debug port's upload limit.
- Compress, all levels plus custom sizes, on quality, scan, complex and edge PDFs (transparency, palette, CMYK, grayscale, rotated pages, duplicates, a picture inside a form): page count, text, per-page pixels and MuPDF warnings (`scripts/test-compress-rust.mjs`). It found one real bug (wrong `/Length` on re-encoded images), fixed.
- Page tools: page order, blank pages, rotation, crop boxes on rotated pages, zip contents (`scripts/test-pages-rust.py`).
- Watermark, Page numbers and Sign: Rust against the 1.4.0 workers on the same input and settings, page by page (14 cases: rotated and cropped pages, tiled, below the text, images, mirrored numbers): 13 are pixel-identical, one differs by 0.1 dB (`scripts/test-stamp-rust.ts`). Redact: the redacted text is gone from the file and the rest keeps its text.
- Memory fail-safe: unit tests for the budget and levels (`cargo test`) and a run under a 256 MB budget.
- `npm test`: the 1.4.0 conversion, editor and Word-picture suites still pass.

Full log: [docs/testing/WINDOWS_TESTS.md](testing/WINDOWS_TESTS.md).
