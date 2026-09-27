# IHatePDF — Test Report

Every result below comes from real runs against generated dummy documents. Nothing is hand-edited.

## 1. Automated suites (`npm test`)

```bash
npx tsx scripts/generateTestFixtures.ts
npm test
```

**45 / 45 passing:** 17 conversion and tool checks (`verify-conversions.ts`), plus 28 editor-engine, encryption, layout and tool checks (`test-editor-and-tools.ts`).

The engine suite runs on `test-fixtures/complex/complex.pdf`, a deliberately awkward file. It contains:
- kerned `TJ` arrays, `'` and `"` operators, and a superscript;
- a shared header in a form XObject;
- a page rotated 90° with a crop box;
- a subset Type0 (CID) font;
- rotated text, a two-column layout, a table, a bullet list and an AcroForm.

```
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
VERIFICATION COMPLETE: 17 passed, 0 failed (17 total)
ALL TESTS PASSED WITH 100% SUCCESS RATE.
--- Building complicated fixture ---
--- Edit engine ---
  [PASS] analysis finds the heading, the paragraph (as one block) and the kerned TJ line
  [PASS] analysis keeps two columns apart
  [PASS] replacing a paragraph removes the old words and adds the new ones
  [PASS] editing text in the shared header form leaves page 2 untouched
  [PASS] deleting the kerned TJ line keeps the rest of its BT block in place
  [PASS] moving a block keeps its text and changes its position
  [PASS] style changes (bold, size, color) re-typeset the block
  [PASS] editing on a rotated, cropped page and with an embedded subset font
  [PASS] added text, shapes, highlight and image render into the page
  [PASS] existing images can be deleted and moved
--- Encryption / decryption ---
  [PASS] fixtures are valid encrypted PDFs (pdf.js reads them)
  [PASS] owner-password-only RC4 file opens with no password and every tool can use it
  [PASS] AES-128 file with an open password: rejected without, opened with
  [PASS] Protect (AES-256) then Unlock round-trips
--- Layout analysis & conversions ---
  [PASS] layout: heading, table, list and separate columns detected
  [PASS] Markdown output has #, table pipes and list items
  [PASS] Word output builds
--- Tools on the complicated fixture ---
  [PASS] Compress keeps pages and never grows the file
  [PASS] Crop respects rotation (displayed top margin on the rotated page)
  [PASS] Watermark with non-Latin text (Unicode fallback font), tiled
  [PASS] Page numbers land upright on the rotated page
  [PASS] Split into groups -> ZIP; organize with blank page and rotation
  [PASS] Redact flattens only the redacted page
  [PASS] PDF/A: output intent, XMP and ID present
  [PASS] Forms: detect and fill (with non-Latin value), flatten
  [PASS] Sign places the image on the displayed page
  [PASS] Repair rebuilds a truncated file
  [PASS] Word diff finds an inserted and a removed word
28 passed, 0 failed
```

## 2. Browser end-to-end: every tool (`scripts/e2e/all-tools.mjs`)

This suite drives the production build (`vite preview`) in Chromium through the UI, the way a person would. It uploads the files, clicks the controls, lets the result save, and then opens the saved output to check it.

| Tool | Input | Checked result |
|---|---|---|
| Merge | complex.pdf + test-multi.pdf | 7 pages |
| Split | test-multi.pdf | selected range extracted (1 page) |
| Organize | reverse order | 4 pages, new order |
| Rotate | all pages right | rotations 90,90,90,90 |
| Crop | test-multi.pdf | crop box applied (555×735) |
| Compare | original vs edited copy | 2 changes · +9 words · −18 words |
| Edit PDF | double-click a heading, retype, Esc | new text in file, old text gone |
| Sign | typed signature, click to place | signature on page |
| Fill forms | text field with “Zoë Test” | 3 pages, filled |
| Watermark / Page numbers / Redact (search “Revenue”) | complex.pdf | 3 pages each; redaction verified visually |
| Images to PDF | JPG + PNG photos | 2 pages |
| Word / Excel / PowerPoint / HTML to PDF | .docx / .xlsx (2 sheets, 120 rows) / .pptx / .html | 2 / 6 / 3 / 4 pages |
| Scan to PDF | photo upload | 1 page |
| PDF to Word / Excel / PowerPoint | complex.pdf | valid .docx / .xlsx / .pptx |
| PDF to images | test-multi.pdf | ZIP of pages |
| PDF to Markdown | complex.pdf | heading, table and list present |
| Compress | 35.5 MB scanned PDF | 1.70 MB |
| Repair | complex.pdf cut off at 97% | all 3 pages recovered |
| PDF/A | complex.pdf | 3 pages, PDF/A metadata |
| Protect → Unlock | password “secret123” | encrypted, then decrypted |
| Auto-save | Page numbers, no clicks | saved itself after 5.3 s as `complex_numbered.pdf`; renamed copy saved as `My renamed file.pdf` (illegal characters removed) |

**Result: 29 / 29 passing.** I also looked at rendered pages of the outputs: edited text, Word/Excel/PowerPoint/HTML conversions, watermark and redaction.

## 3. Compression (`scripts/e2e/compress.mjs`, `renderCompare.mjs`)

| File | Level | Result |
|---|---|---|
| scan_photos.pdf (35.5 MB, 6 photos) | Light / Balanced / Smallest | 8.00 MB / 1.70 MB / 341 KB |
| scan_photos.pdf | Custom 10 MB / 2 MB / 400 KB | 8.63 MB / 1.95 MB / 354 KB — all under target |
| mixed_images.pdf (88.6 MB: JPEG, JPEG 2000, CMYK, ICC, indexed, 16-bit, soft-masked) | Balanced | 3.06 MB, 8 of 8 images recompressed |
| mixed_images.pdf | Custom 2 MB | 1.79 MB |

The pixel comparison of original vs compressed pages (Balanced) shows a mean difference of at most 0.59/255 per page. Mean page colors match, so CMYK, indexed and masked images keep their colors.

## 4. Desktop app (`xvfb-run node scripts/e2e/electron.mjs`)

This runs the real Electron 44 app with the production build:
- The window was visible, with the tool list ready, **~0.5 s** after launch.
- Compressing the 88.6 MB mixed-image file (the JPEG 2000 WASM decoder is served over `app://`) produced 3.06 MB. The file **auto-saved to `~/Downloads/IHatePDF/`**, and the page showed where it went.
- The editor loaded complex.pdf and detected its 17 text blocks.
- Closing the window **ended the whole process in 71 ms**.

The Windows installer (`FinalApp/IHatePDF-Setup.exe`) is built with `npm run build:exe`. The packed app contains only `dist/` and `electron/` (27 MB `app.asar`).
