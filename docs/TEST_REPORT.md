# IHatePDF — Test Report

Generated from an actual automated run of the complete test suite. Reproduce with:

```bash
npx tsx scripts/generateTestFixtures.ts
npx tsx scripts/verify-conversions.ts
```

## Result: 17/17 passing (100% success rate)

```
====================================================
IHatePDF - Comprehensive End-to-End Verification
====================================================

--- TEST 1: PPTX to PDF Pipeline ---
  [PASS] pptxParser extracts theme, slide dimensions, vector shapes, and tables
  [PASS] convertPptxToPdf: test-slides.pptx -> count === 3, 16:9 widescreen, non-blank

--- TEST 2: DOCX to PDF Pipeline ---
  [PASS] docxParser: parses section dimensions, callouts, tables, and colored runs
  [PASS] convertDocxToPdf: test-document.docx -> count >= 2, formatted tables & callouts

--- TEST 3: Round-Trip Document Conversions ---
  [PASS] Images -> PDF (imagesToPdf): builds valid multi-page PDF from image bytes
  [PASS] PDF -> DOCX (buildDocxFromPages): generates valid .docx with structured paragraphs
  [PASS] PDF -> PPTX (buildPptxFromPages): generates valid .pptx with positioned text & slides

--- TEST 4: Core Visual PDF Tools ---
  [PASS] Merge PDFs: 4-page test-multi.pdf + 1-page PDF -> 5 pages total
  [PASS] Split PDF: extracts specific page range [1, 2] -> 2 pages
  [PASS] Split PDF: burst "all" mode -> ZIP archive with 4 individual pages
  [PASS] Rotate PDF: rotates pages by 90 degrees
  [PASS] Organize PDF: reorders and removes specified pages
  [PASS] Compress PDF: recommended mode strips metadata and preserves page count
  [PASS] Protect PDF: encrypts document with AES-256 password
  [PASS] Unlock PDF: decrypts AES-256 encrypted document with valid password
  [PASS] Watermark PDF: stamps text watermark across all pages
  [PASS] Page Numbers: stamps formatted page labels on all pages

====================================================
VERIFICATION COMPLETE: 17 passed, 0 failed (17 total)
====================================================

ALL TESTS PASSED WITH 100% SUCCESS RATE.
```

## Test Coverage Breakdown

Every check above directly exercises the actual shipped worker/pipeline logic (`*.worker.ts` and underlying parsers/renderers) — with real OOXML parsing and pure `pdf-lib` generation:

| Pipeline / Tool | Scope Covered | Technical Implementation |
|---|---|---|
| **PowerPoint to PDF** | 3 slides, 16:9 widescreen aspect ratio, vector shapes, tables, dark theme | Pure OOXML slide parser (`pptxParser.ts`) + `pdf-lib` renderer (`pptToPdf.worker.ts`) |
| **Word to PDF** | Multi-page flow (>= 2 pages), styled tables, callout blocks, colored text runs | Pure OOXML document parser (`docxParser.ts`) + `pdf-lib` layout engine (`renderDocxToPdf.ts`) |
| **Images to PDF** | Multi-page PDF assembly, scaling, aspect ratio preservation | `imagesToPdf.worker.ts` |
| **PDF to DOCX** | Structured text blocks, font sizes, heading detection, OOXML document packaging | `buildDocxFromPages` in `pdfToWord.worker.ts` via `docx` `Packer.toArrayBuffer` |
| **PDF to PPTX** | Positioned text frames, slide dimensions, pptx packaging | `buildPptxFromPages` in `buildPptx.worker.ts` via `pptxgenjs` |
| **Merge PDF** | Multi-document concatenation, preserving page count | `mergePdfs` in `merge.worker.ts` |
| **Split PDF** | Range extraction (`[1, 2]`) and burst "all" mode (ZIP archive) | `splitPdf` in `split.worker.ts` |
| **Rotate PDF** | 90° page orientation rotation | `rotatePdfPages` in `rotate.worker.ts` |
| **Organize PDF** | Page reordering and deletion | `organizePdfPages` in `organize.worker.ts` |
| **Compress PDF** | Recommended mode: object stream optimization, metadata stripping | `compressPdf` in `compress.worker.ts` |
| **Protect PDF** | Password encryption using AES-256 (Standard Security Handler rev 6) | `protectPdf` in `protect.worker.ts` + `pdfEncryptDocument.ts` |
| **Unlock PDF** | Decryption and password verification using AES-256 | `unlockPdf` in `unlock.worker.ts` + `pdfEncryptDocument.ts` |
| **Watermark PDF** | Text and image watermarking with rotation and positioning | `applyWatermark` in `watermark.worker.ts` |
| **Page Numbers** | Dynamic numbering format (`n_of_total`, `roman`, `n`), font, position | `addPageNumbers` in `pageNumbers.worker.ts` |

## Offline & Security Guarantees
- 100% Client-Side execution — zero network requests, zero telemetry, zero analytics.
- Web Worker and WebAssembly architecture with zero-copy `ArrayBuffer` transfer lists.
- Strict memory management with canvas bitmap zeroing (`width=0; height=0;`) and `memoryManager.destroyPdfDocument(doc)`.
