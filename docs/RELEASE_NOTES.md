# IHatePDF v2.2.2

The desktop app on **Tauri** with a **Rust core** (since 2.0). 2.2.2 is a small fix on top of 2.2.1.

## Install

1. Download **IHatePDF-Setup.exe** below, under *Assets* (about 26 MB).
2. Run it. If Windows says *"Windows protected your PC"*, click **More info → Run anyway**. The installer isn't code-signed.
3. It installs for your Windows account only (no administrator permission). Updating from 2.x installs over it. Coming from 1.x: uninstall 1.x first from *Settings → Apps*. Your saved files are never touched. It needs Microsoft Edge WebView2, which is part of Windows 10 and 11.

## New in 2.2.2

- **The GitHub button works again.** In the desktop app it did nothing (the app window blocks new windows); links now open in your default browser.
- **New: the maker's site.** A button with the [devbhamaria.com](https://devbhamaria.com) mark sits next to the GitHub button and opens the site.

Changes since 2.2.1: [v2.2.1...v2.2.2](https://github.com/Burthcer/IHatePDF/compare/v2.2.1...v2.2.2).

## New in 2.2.1

- **Split: parts follow on.** "Add part" starts the new part right after the one before it (part 1 = `1-5` → part 2 = `6-…`), and a part the app filled in keeps following: change part 1 to `1-8` and part 2 becomes `9-…`. Once you type in a part (or tap pages for it) it stays as you set it.
- **Split: overlaps and gaps are pointed out.** A page that goes into two parts (say part 2 changed to `5-12` while part 1 is `1-5`) gets both parts' colours and an amber "parts 1, 2" label, and each part's card says "Page 5 is also in part 1 (in both files)". Pages that are in no part are listed ("Not in any part (left out): 11-12").
- A part that the app filled in but has no pages left says so instead of a generic range error.

Changes since 2.2.0: [v2.2.0...v2.2.1](https://github.com/Burthcer/IHatePDF/compare/v2.2.0...v2.2.1). Earlier releases: [v2.2.1](https://github.com/Burthcer/IHatePDF/releases/tag/v2.2.1), [v2.2.0](https://github.com/Burthcer/IHatePDF/releases/tag/v2.2.0), [v2.1.0](https://github.com/Burthcer/IHatePDF/releases/tag/v2.1.0), [v2.0.0](https://github.com/Burthcer/IHatePDF/releases/tag/v2.0.0).

## New in 2.2.0

- **Split: name each part.** Every part in "Choose pages" has a file-name box (the default name is shown greyed out). Characters a file name can't contain are dropped, and two parts with the same name become `name.pdf` and `name (2).pdf`. Each part shows the file it will produce.
- **Split: colour per part.** Each part has its own colour on its card, and every page is outlined in the colour of the part it goes into (the selected part's pages with a thicker outline), with "part N" under the page in the same colour. Every N and One per page colour their files the same way.

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

## How 2.2.2 was tested

- The desktop app built from this code: clicking the GitHub and devbhamaria.com buttons opens both in the default browser (Edge), and the app stays on its page.
- Every tool end to end (`scripts/e2e/all-tools.mjs`) in the browser build, the installed app (Rust engine) and the phone build. The Split test now also checks that part 2 follows part 1 (`1-3` → `4`), that a typed part stops following, that an overlap is reported ("Page 2 is also in part 1"), and the named output (`test-multi_1_p1-2.pdf` + `Chapter two.pdf`).
- The same suite on a phone-sized touch screen (Android emulator), plus real finger input: dragging a signature, a crop edge, a redaction box and an Edit PDF text block, and the reorder arrows.
- `npm test` (conversion, editor and Word-picture suites).

Full log: [docs/testing/WINDOWS_TESTS.md](testing/WINDOWS_TESTS.md).
