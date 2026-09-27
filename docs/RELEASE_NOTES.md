# IHatePDF v1.1.0

A reliability release: every tool was re-tested end to end on real files, and everything that didn't work was fixed.

## New

- **Custom compression size.** Choose *Custom size*, type a target in MB or KB (it can only shrink, never grow), and the compressor finds the best image resolution and quality that fits, e.g. 35.5 MB → 1.95 MB for a 2 MB target.
- **Auto-save.** Finished results save themselves after a 5-second countdown under an automatic name. During the countdown you can rename the file, save it right away, or turn auto-save off for that result. You can also save a copy under another name later. The editor's Download button uses the same flow.
- **Desktop app saves to `Downloads\IHatePDF`** with no dialog. Existing names get a ` (2)` suffix, and **Show in folder** opens the location.
- **Word-processor-style PDF editing.** Double-click any text to retype it. The paragraph reflows in the document's own font, and the old characters are removed from the file, not just covered. You can also move and resize text and images, and add text, images, shapes, highlights and whiteout.
- **Redesigned interface** across the home screen and every tool.

## Fixed

- **Compress now actually compresses.** Before, it only recompressed plain RGB/gray JPEGs, so most real PDFs came back unchanged apart from the name. It now decodes and re-encodes:
  - JPEG, JPEG 2000, CMYK, ICC-based, indexed, 16-bit, soft-masked and predictor-compressed images;
  - downsampled to the chosen DPI at their *displayed* size.

  It also merges duplicate images and drops unused objects. A 35.5 MB scan goes to 1.7 MB (Balanced), and an 88.6 MB mixed file to 3.1 MB, with no visible change.
- **Double-click to edit text** in the editor didn't open the text box: the drag handler captured the pointer and swallowed the double-click. Pressing Esc while typing now keeps your text.
- **Page rendering and password detection** broke on Chromium/Electron builds without the newest JavaScript APIs (`Math.sumPrecise`, `Map#getOrInsertComputed`). This could also make a password-protected file look unprotected. The app now uses pdf.js's legacy build, which includes polyfills.
- **Repair** recovers truncated downloads: a cut-off compressed object stream is partially recovered, unreadable objects are skipped, and a lost page tree is rebuilt.
- **HTML to PDF** could convert the previous HTML if you clicked *Create PDF* right after pasting or opening a file.
- **PDF to Markdown / Excel / Word:**
  - tables drawn with padding spaces are detected;
  - two side-by-side text columns are no longer mistaken for a table;
  - superscripts stay on their line.
- **Desktop app:**
  - closing the window always quits (nothing is left running in the background);
  - only one copy runs at a time;
  - the window appears once the first frame is drawn, with no blank white window;
  - compiled code is cached, so later launches are faster;
  - pdf.js is loaded on first use, so the startup bundle is 225 KB instead of 712 KB;
  - the app is served over an `app://` protocol, so WASM decoders and workers behave exactly as on the web;
  - the installer has a proper icon and no longer bundles unused `node_modules`.

## Testing

`npm test` (45 checks) plus browser end-to-end runs of all 28 tools, the compression levels on 35–90 MB files, and the Electron app. See [TEST_REPORT.md](./TEST_REPORT.md).

---

# IHatePDF v1.0.0

First major production release. A full PDF tool suite that runs entirely on your device — 100% client-side, zero backend, zero network transfer, no accounts, and no AI dependencies.

## Highlights

- **28 Full-Featured PDF Tools**:
  - **Organize**: Merge, Split (custom ranges & burst all), Organize (reorder, duplicate, delete), Rotate (90/180/270°), Crop, Compare.
  - **Optimize**: Compress (extreme, recommended, low), Repair.
  - **Convert**: PowerPoint to PDF, Word to PDF, Excel to PDF, Images to PDF, HTML to PDF, Scan to PDF, PDF to Word (.docx), PDF to PowerPoint (.pptx), PDF to Excel (.xlsx), PDF to JPG/PNG, PDF to Markdown.
  - **Edit**: Watermark (text & image with custom angles/positions), Page Numbers (formatted 'Page N of M', Roman, numbers), PDF Form filler (AcroForms), Edit PDF, Redact PDF (irrecoverable rasterization).
  - **Security**: Protect PDF (AES-256 revision 6 encryption), Unlock PDF, PDF to PDF/A archival, Sign PDF.

- **High-Fidelity Document Conversion Engine**:
  - **PowerPoint (.pptx) to PDF**: Pure OOXML slide parser (`pptxParser.ts`) and direct vector renderer. Supports 16:9 widescreen aspect ratio, vector shapes (rectangles, rounded rectangles, ellipses, lines), embedded images (`<p:pic>`), dark and gradient theme backgrounds, styled tables with cell fills, and full typography.
  - **Word (.docx) to PDF**: Direct OOXML parser (`docxParser.ts`) and layout engine (`renderDocxToPdf.ts`) running offline in Web Workers and Node.js without browser GPU dependencies. Accurately handles multi-page wrapping, styled tables with custom borders, colored callout boxes, direct text colors, headings, and explicit page breaks.
  - **PDF to Word (.docx)**: Positioned text extraction, typography mapping, and heading detection via `docx` library.
  - **PDF to PowerPoint (.pptx)**: Preserves high-res visual slide backgrounds with editable positioned text overlays via `pptxgenjs`.

- **Comprehensive Automated Test Suite**:
  - Verified with `scripts/verify-conversions.ts` passing 17/17 tests across all conversion pipelines and core PDF operations with 100% success rate (see [TEST_REPORT.md](./TEST_REPORT.md)).

- **100% Offline & Air-Gapped**:
  - Every operation executes locally in RAM via WebAssembly, Web Workers, and `ArrayBuffer`s.
  - Zero network calls: no analytics, no tracking, no external CDNs, no AI endpoints.
  - Strict resource management: canvas GPU bitmap zeroing (`width=0; height=0;`) and automatic `PDFDocumentProxy` destruction.

- **Windows NSIS Desktop Installer**:
  - `IHatePDF-Setup.exe` is a standalone NSIS installer that packages the complete application for Windows (x64) with Start Menu and desktop shortcuts.

## Downloads

| File | Description |
|---|---|
| `IHatePDF-Setup.exe` | Windows installer (NSIS wizard, x64). Run it and follow the prompts. |

### SHA-256 Checksum

```
IHatePDF-Setup.exe
636D58CA5A52B09ECB0F20E82FA82E0757F0522CA216794F4F24830106A7C815
```

Verify in PowerShell:
```powershell
Get-FileHash .\IHatePDF-Setup.exe -Algorithm SHA256
```

## Installation

Download `IHatePDF-Setup.exe`, launch the installer, and follow the setup wizard prompts. The application is completely self-contained with no external runtimes required.

