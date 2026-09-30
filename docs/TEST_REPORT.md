# IHatePDF — Test Report (v1.3.1)

Every result below comes from real runs against generated dummy documents. Nothing is hand-edited. **Version 1.3.1** was tested on Windows (the installed app, on a real Windows 11 PC) and on Linux; the **1.3.0** results that follow are still valid for everything 1.3.1 didn't change.

**80 checks passing:** 17 + 34 automated checks (`npm test`) and all 29 tools through the browser (`scripts/e2e/all-tools.mjs`), on Windows.

# Version 1.3.1

## Windows: memory fail-safe on the installed app

Windows 11 Home (build 26200), Intel Core Ultra 9 185H, 32 GB RAM; `IHatePDF-Setup.exe` 1.3.1-beta.3 installed over 1.3.0 (one entry in *Settings → Apps*, shortcuts kept). Driven by `scripts/e2e/memory/` with `IHP_EXE` set to the installed app. Inputs: 300 dpi JPEG scans of 10, 50, 150 and 500 MB (`node scripts/generateScanFixtures.mjs`; 500 MB = 144 pages). Budgets forced with `IHP_MEMORY_BUDGET_MB`: 624 (a 4 GB PC with 400 MB less, for Windows' higher idle memory), 1024 (4 GB), 3072 (6 GB), 4096 (8 GB), 8192 (16 GB), and unset (this PC: 16 GB). Commands, expected results and every row: [`docs/testing/WINDOWS_TESTS.md`](testing/WINDOWS_TESTS.md).

**Every tool, every budget** (`matrix.mjs`: Compress, Watermark, Merge, Rotate, Page numbers, PDF → Word × 4 scans × 6 budgets = 144 runs; `student.mjs`: every tool on a normal student file at 624 and 1024 = 56 runs):

| Budget (PC) | Scans: finished / slowed / stopped | Student files: finished / slowed / stopped |
|---|---|---|
| 624 (4 GB, tight) | 10 / 14 / 0 | 19 / 9 / 0 |
| 1024 (4 GB) | 15 / 9 / 0 | 24 / 4 / 0 |
| 3072 (6 GB) | 24 / 0 / 0 | |
| 4096 (8 GB) | 24 / 0 / 0 | |
| 8192 (16 GB) | 24 / 0 / 0 | |
| unset (16 GB) | 24 / 0 / 0 | |

Every Compress: all images recompressed (3/3, 15/15, 44/44, 144/144). PDF → Word on the 500 MB scan finished at 624 (slowed, 92 s) and 1024 (145 s).

**Compress, 1.3.0 vs 1.3.1 on the same PC:**

| Scan | 1 GB budget, 1.3.0 | 1 GB, 1.3.1 | 3 GB (6 GB PC) | 4 GB (8 GB PC) | unset (16 GB) |
|---|---|---|---|---|---|
| 10 MB → 831 KB | stopped in 1–2 s | 2.9 s | 2.9 s | 2.9 s | |
| 50 MB → 4.04 MB | stopped | 10.6 s | 10.1 s | 9.5 s | |
| 150 MB → 11.7 MB | stopped | 31.3 s | 26.0 s | 26.6 s | |
| 500 MB → 38.4 MB | stopped | 120.6 s | 107.9 s | 91.4 s | 87.1 s |

Watermark on the 500 MB scan: stopped in 1.3.0 at 1 GB; 2.6 s in 1.3.1 (peak 1.1 GB for the whole app).

**Windows busy with other programs** (`busy.mjs`; this PC's budget; the free memory the app is told shrinks as the job grows). On this 32 GB PC the reserve kept for Windows is 3.2 GB, so the cases are given above it, with the same margins as 2,400 and 1,800 MB free on a 16 GB PC:

| Windows leaves free | Compress 150 MB | PDF → Word 150 MB | Watermark 500 MB |
|---|---|---|---|
| 8,192 MB | finished, 33.7 s, 44/44 images | finished, 7.7 s | finished, 2.2 s |
| reserve + 762 MB | slowed, 38.4 s, 44/44 images | slowed, 29.7 s | finished, 1.9 s |
| reserve + 162 MB | **stopped** after 10.1 s: *"Windows is almost out of memory (2.9 GB free of 31.4 GB)"* | slowed, 39.0 s | slowed, 4.1 s |

With less than the reserve free (2,400 and 1,800 MB on this PC), Compress and Watermark stopped with the same message, and PDF → Word's window was restarted by the watchdog instead of showing it. With 80 MB above the reserve, PDF → Word on the 500 MB scan slowed down and finished (264 s): on a 32 GB PC the emergency threshold (5% of RAM, 1.6 GB) is below the reserve.

**Last resorts** (`lastresort.mjs`):

| Case | Result |
|---|---|
| 300-megapixel PNG → PDF at 1 GB | Refused in 0.4 s: *"part of this job needs more memory than IHatePDF may use here…"*; app usable afterwards |
| Windows down to 300 MB free during Compress 150 MB | Stopped in 2.4 s: *"Windows is almost out of memory (0.3 GB free…)"*; app usable afterwards |
| A window stuck grabbing memory, 1 GB budget | Restarted in 1.5 s, notice shown |

**Other Windows checks** (`windows-checks.mjs`):

| Check | Result |
|---|---|
| App memory, home screen | 398 MB |
| App memory, 500 MB scan open in Rotate | 1,424 MB (first 12 previews after 1.1 s) |
| First 12 previews of the 50 MB scan in Rotate | 7.4 s at 1 GB, 0.9 s unset |
| Watermark "गोपनीय" / "机密", Edit PDF with Hindi and Chinese | Correct characters and joined Devanagari in Edge's PDF viewer; Noto fonts embedded; text extractable |
| PDF → Word on a heading edited to "गोपनीय दस्तावेज़ 机密文件" | Both scripts in the .docx; Word displays them |
| Network requests (every request recorded) | None outside the app |
| Startup | About 8 s for the first launch after installing, then under 0.5 s |

## Linux: memory fail-safe on the dev build

The same kind of scans in the desktop app on a 16 GB Linux PC (`xvfb-run`), with the budget of a 4 GB PC (1 GB) and 400 MB less (624 MB):

| Tool | 10 / 50 / 150 / 500 MB scan, 624 MB budget | 500 MB scan, 1 GB budget |
|---|---|---|
| Compress | all finished (4 s / 12 s / 32 s / 107 s) | finished, 100 s |
| Watermark | all finished (1–5 s) | finished, 5 s |
| Merge (+ a 20-page journal) | all finished (0–4 s) | finished, 4 s |
| Rotate | all finished (0–4 s) | finished, 4 s |
| Page numbers | all finished (1–4 s) | finished, 4 s |
| PDF → Word | all finished; the 500 MB scan slowed down and paused, 123 s | finished, 110 s |

- Every tool finished a 50 MB scan or a 10–20 page journal at both 624 MB and 1 GB (60 of 60).
- A single 300-megapixel image is refused before anything starts; with almost no free memory the running job stops in 3 s; a window stuck grabbing memory is restarted in 1.5 s. After each, the app carried on working.
- PDF → Word builds the Word file in one piece: on the 500 MB, 138-page scan at 624 MB it finished in two runs out of three and stopped with the message in the third.

## Known limits found in 1.3.1

- Compress can stop with *"Windows is almost out of memory"* when Windows is within ~160 MB of the reserve it keeps free (other tools slow down and finish). On Windows a paused job's memory takes longer to come down than on Linux.
- PDF → Word leaves out sideways (rotated) text, in any language.
- Page previews are ~8× slower at a 1 GB budget (pdf.js's own JPEG decoder, used to save memory).

# Version 1.3.0

Every result below comes from real runs of version 1.3.0. The large-file and fail-safe tests ran the real desktop app (Electron 44) on a 16 GB, 4-core Linux machine; "1.2.0" columns are the same tests run on version 1.2.0.

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
