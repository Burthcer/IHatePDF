# IHatePDF v2.1.0

The desktop app on **Tauri** with a **Rust core** (since 2.0), now with a rebuilt Split tool and fixes from testing the app on phones and narrow windows.

## Install

1. Download **IHatePDF-Setup.exe** below, under *Assets* (about 26 MB).
2. Run it. If Windows says *"Windows protected your PC"*, click **More info → Run anyway**. The installer isn't code-signed.
3. It installs for your Windows account only (no administrator permission). Updating from 2.0.0 installs over it. Coming from 1.x: uninstall 1.x first from *Settings → Apps*. Your saved files are never touched. It needs Microsoft Edge WebView2, which is part of Windows 10 and 11.

## New in 2.1.0

- **Split, rebuilt.** "Choose pages" now works in *parts*: each part has its own box for page ranges (`1-3, 5, 8-`) and becomes its own PDF. Add as many parts as you need ("Add part" starts the next one where the last ended), remove any of them, and click page thumbnails to add or remove pages from the selected part. One part gives one PDF; several give a ZIP. "Every N pages" and "One per page" are unchanged.
- **Organize pages and Images to PDF:** arrows under each page/image move it earlier or later, so reordering works without drag and drop (keyboard and touch screens).
- **Edit PDF in a narrow window:** the toolbar wraps instead of hiding Undo, zoom and Download off the edge, and the properties panel appears under the page while something is selected.
- **Scan to PDF:** "Add photos" opens the photo picker (it no longer forces the camera); the page look (Color / Gray / Document) sits under the camera so nothing moves after the first capture.
- Touch screens: dragging a signature, crop edge, redaction box or selected Edit PDF object moves it instead of scrolling the page; small drag handles have a bigger hit area; buttons that only appeared on mouse hover are always visible.
- Page previews in Redact, Sign, Crop, Scan and HTML to PDF fit narrow windows.

## Since 1.4.0 (the 2.0 rebuild)

| | 1.4.0 | 2.x |
|---|---|---|
| Installer | 130 MB | **about 26 MB** |
| Launch to home screen (median of 3) | 1.19 s | **0.91 s** |
| Compress, 10 MB scan, click to result | 2.3 s | **0.8 s** |
| Compress, peak extra memory, same file | +706 MB | **+130 MB** |

**In Rust:** Compress, Merge, Split, Organize pages, Rotate, Crop, Images to PDF (and Scan to PDF), PDF to JPG/PNG, Redact, Watermark, Page numbers, Sign, Repair (PDFium), Word, PowerPoint, Excel and HTML to PDF, PDF to PowerPoint, page previews and text reading (PDFium). Each falls back to the 1.4.0 engine for anything it can't handle, so a tool never does worse than before. Edit PDF, Forms, PDF/A, Protect, Unlock and Compare keep the 1.4.0 engines.

## How 2.1.0 was tested

- Every tool end to end (`scripts/e2e/all-tools.mjs`), including Split with two parts (ZIP with `p1-2` and `p3-4`), on the desktop web build.
- The same suite on a phone-sized touch screen (Android emulator), plus real finger input: dragging a signature, a crop edge, a redaction box and an Edit PDF text block, and the reorder arrows.
- `npm test` (conversion, editor and Word-picture suites).

Full log: [docs/testing/WINDOWS_TESTS.md](testing/WINDOWS_TESTS.md).
