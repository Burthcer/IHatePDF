# IHatePDF — Test Report (v1.3.0)

Every result below comes from real runs of version 1.3.0 against generated dummy documents. Nothing is hand-edited. The large-file and fail-safe tests ran the real desktop app (Electron 44) on a 16 GB, 4-core Linux machine; "1.2.0" columns are the same tests run on version 1.2.0.

## 1. Automated suites (`npm test`)

```bash
npx tsx scripts/generateTestFixtures.ts
npm test
```

**50 / 50 passing:** 17 conversion and tool checks (`verify-conversions.ts`), plus 33 editor-engine, encryption, layout, font and tool checks (`test-editor-and-tools.ts`).

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
  [PASS] layout: pictures found where they are drawn (for PDF→Word)
  [PASS] Markdown output has #, table pipes and list items
  [PASS] tables: centred headers and right-aligned numbers keep their columns; prose stays prose
  [PASS] Word output builds
--- Tools on the complicated fixture ---
  [PASS] Compress keeps pages and never grows the file
  [PASS] Crop respects rotation (displayed top margin on the rotated page)
  [PASS] Watermark with non-Latin text (Unicode fallback font), tiled
  [PASS] Chinese/Japanese watermark: every character embedded and readable (subset fix)
  [PASS] Hindi/Marathi watermark and page numbers: shaped with the Devanagari font
  [PASS] Page numbers land upright on the rotated page
  [PASS] Split into groups -> ZIP; organize with blank page and rotation
  [PASS] Redact flattens only the redacted page
  [PASS] Redact writes pages one at a time (asks for each render as it writes it)
  [PASS] PDF/A: output intent, XMP and ID present
  [PASS] Forms: detect and fill (with non-Latin value), flatten
  [PASS] Sign places the image on the displayed page
  [PASS] Repair rebuilds a truncated file
  [PASS] Word diff finds an inserted and a removed word
33 passed, 0 failed
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

## 3. Compression (`scripts/e2e/compress.mjs`)

| File | Level | Result |
|---|---|---|
| scan_photos.pdf (35.5 MB, 6 photos) | Light / Balanced / Smallest | 8.00 MB / 1.70 MB / 341 KB |
| scan_photos.pdf | Custom 10 MB / 2 MB / 400 KB | 8.63 MB / 1.95 MB / 354 KB — all under target |
| mixed_images.pdf (88.6 MB: JPEG, JPEG 2000, CMYK, ICC, indexed, 16-bit, soft-masked) | Balanced, desktop app | 3.06 MB, 8 of 8 images recompressed |

## 4. Desktop app (`xvfb-run node scripts/e2e/electron.mjs`)

- The window was visible, with the tool list ready, **0.47 s** after launch.
- Compressing the 88.6 MB mixed-image file produced 3.06 MB, which **auto-saved to `~/Downloads/IHatePDF/`**.
- The editor loaded complex.pdf and detected its 17 text blocks.
- Closing the window **ended the whole process in 41 ms**.
- Output names in Hindi, Japanese and with brackets/dashes (`रिपोर्ट 2026 (final) – 日本_compressed.pdf`) are saved exactly.
- `npm run build:exe` builds `IHatePDF-Setup.exe` (130 MB) and checks that the Share-to-phone library (koffi) is inside the packaged app.

## 5. Memory fail-safe

IHatePDF sets itself a RAM budget from the PC's memory (4 GB PC → 1 GB, 8 GB → 4 GB, 16 GB → 8 GB, at most 16 GB) and a watchdog checks the app's real memory use twice a second. Small budgets were forced with `IHP_MEMORY_BUDGET_MB` to simulate smaller PCs.

| Scenario | Result |
|---|---|
| A job that needs more than the budget (0.7 GB budget, compress a 1 GB PDF) | Stopped after 2.9 s with *"Stopped to protect this PC"*; memory back to normal; the app stays usable, no restart |
| A stuck window grabbing memory in a loop (simulated attack) | Window ended after 1.3 s (peak 1.8 GB) and reloaded with *"IHatePDF restarted to protect this PC"* |
| 4 GB PC (1 GB budget): watermark a 500 MB PDF | Finished, 878 MB peak |
| 4 GB PC (1 GB budget): compress a 1 GB PDF | Stopped cleanly; memory freed within 1 s |
| 16 GB PC (normal budget): compress a 1 GB PDF | Finished: 1,021 MB → 72 MB |

## 6. Large files: 1.2.0 vs 1.3.0 (desktop app, peak RAM · total time)

Image PDFs from 100 MB to 2 GB:

| Job | 1.2.0 | 1.3.0 |
|---|---|---|
| Rotate 2 GB PDF | **crashed** (13 GB) | 1.6 GB · 60 s |
| Watermark 2 GB PDF | **crashed** (13 GB) | 0.9 GB · 50 s |
| Compress 2 GB PDF (→ 72 MB) | 8.9 GB · 146 s | 1.1 GB · 190 s |
| Merge 2 GB PDF + 100 pages | 10.9 GB · 50 s | 0.9 GB · 45 s |
| Protect 2 GB PDF | 10.9 GB · 59 s | 0.9 GB · 51 s |
| Open 2 GB PDF in the editor | 6.8 GB | 1.2 GB |
| Watermark 1 GB PDF | 9.1 GB · 35 s | 0.9 GB · 19 s |
| Compress 1 GB PDF | 5.6 GB · 125 s | 1.2 GB · 171 s |
| Watermark 500 MB PDF | 5.2 GB · 17 s | 0.9 GB · 9 s |
| Rotate 500 MB PDF | 4.7 GB · 17 s | 1.6 GB · 11 s |
| Repair 500 MB PDF cut off at 90% | 7.3 GB · 32 s | 3.1 GB · 48 s |

5,000-page text PDFs:

| Job | 1.2.0 | 1.3.0 |
|---|---|---|
| Redact every page | 8.3 GB · 454 s | 1.2 GB · 779 s |
| Rotate | 1.2 GB · 114 s | 0.8 GB · 5 s |
| Organize (reverse) | 1.9 GB · 30 s | 0.8 GB · 5 s |
| Merge 5,000 + 5,000 pages | 0.8 GB · 15 s | 0.8 GB · 6 s |
| Edit a paragraph | 1.1 GB · 12 s | 0.9 GB · 7 s |
| PDF→Markdown | 3.9 GB · 46 s | 1.3 GB · 34 s |
| PDF→Word | 1.2 GB · 16 s | 1.3 GB · 22 s |
| PDF→Excel | 1.3 GB · 39 s | 1.3 GB · 51 s |
| PDF→JPG, 1,000 pages at 150 dpi | 2.4 GB · 61 s | 1.2 GB · 49 s |
| Split, crop, watermark, page numbers, compress, protect, PDF/A, sign | 0.7–1.1 GB, 4–7 s | 0.7–0.9 GB, 4–11 s |

Conversions to PDF:

| Job | 1.2.0 | 1.3.0 |
|---|---|---|
| Excel→PDF, 100,000 rows (3,704 pages) | 4.3 GB · 56 s | 1.9 GB · 97 s |
| Images→PDF, 300 photos (367 MB) | 3.1 GB · 15 s | 1.4 GB · 21 s |
| Word→PDF (150 chapters), PowerPoint→PDF (150 slides), HTML→PDF (3,000 paragraphs) | 0.8–1.5 GB | 0.8–1.6 GB, about 1–5 s slower |

Reading from disk instead of memory makes some jobs slower (compress, Redact, big Excel files); every job above stays under 2 GB except Repair of a large damaged file and a single 300-megapixel PNG (3.8 GB, same as 1.2.0).

## 7. Edge cases and privacy

| Check | Result |
|---|---|
| RC4-40, RC4-128, AES-128, AES-256 password PDFs | Wrong password refused, right one opens; tools and Unlock work on all four |
| Owner-password-only (no print/copy) PDF | Opens without a prompt |
| Protect with printing and copying off | AES-256 (R6); pikepdf confirms printing and copying are blocked |
| Empty, garbage and renamed Word files | Refused cleanly ("not a PDF") |
| PDF with a broken cross-reference table | Tools work (rotate: 3 pages) |
| Damaged PDF in a normal tool | Plain message pointing to Repair PDF |
| Hindi watermark, Hindi and Chinese retyped in Edit PDF | Correct characters, extractable text |
| Scanned PDF → Word | Pages come across as pictures |
| Share to phone: folder with a link loop and a broken link | Both skipped and listed; the rest is shared |
| Share to phone over Wi-Fi (`scripts/e2e/share.mjs`) | QR code, folder and "everything" ZIPs, single file, wrong link refused, countdown, stop: all pass (hotspot and Bluetooth need a Windows PC) |
| Network requests while using every tool (browser and desktop) | **None** outside the app |

## 8. Known limits

- Repairing a large damaged file reads it whole: about 3 GB of RAM for a 450 MB file.
- Password-protected PDFs are decrypted into memory when opened (about twice their size in RAM).
- One piece of text mixing Hindi/Marathi with Chinese/Japanese (e.g. a single watermark) shows only the first script; Edit PDF handles any mix.
- Scanned pages have no text (no OCR); signatures are visible, not certificate-based.
