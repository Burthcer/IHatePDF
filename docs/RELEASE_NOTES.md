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

