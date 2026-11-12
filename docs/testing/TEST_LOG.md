# IHatePDF 2.0 test log (recall sheet)

One place to look up "what did we test, how, and what came out" for the 2.0 Rust port. Meant for answering questions later (for example when writing about the project). Every number here comes from a run on Dev's laptop (Windows 11 build 26200, Intel Core Ultra 9 185H, 31.4 GB); the longer notes per run are in `WINDOWS_TESTS.md`, the status in `CHECKPOINT.md`. Raw outputs stay in `test-fixtures/` (gitignored).

## The method in one paragraph

Each tool that moved from TypeScript to Rust got a **Rust-vs-TypeScript comparison test before it shipped**. Both engines run on the same input; the outputs are compared with MuPDF (page count, extracted words, and pixel similarity as PSNR) or, for data outputs, field by field. The TypeScript engine stays in the app as the fallback: if the Rust engine errors or declines, the old engine runs, so the user never gets less than 1.4.0 did. After the code-level tests, the tools are run again **inside the real installed-style app** (the Tauri exe driven over the WebView2 debug port with Playwright), and a Rust fallback shows up as a console warning that fails the test.

## Headline numbers (as of 2026-11-12, branch `claude/rust-port`)

| Claim | Evidence |
|---|---|
| 9 tools or tool halves now run on Rust with TypeScript fallback | Compress, Redact, Watermark, Page numbers, Sign, Word to PDF, PowerPoint to PDF, Excel to PDF, HTML to PDF (writer), PDF to PowerPoint (text boxes, backgrounds, slide pictures, .pptx writer) |
| 1,611 real and generated pages, 21,067 text boxes: Rust and TypeScript give identical PowerPoint text boxes | `test-editpdf-rust.ts`, 242 PDFs (137 from our own tools and fixtures, 105 real-world study/lecture PDFs from Dev's machine), 0 differences |
| Word to PDF: same pages and words in 10 of 10 files | `test-docx-rust.ts` |
| PowerPoint to PDF: same pages, words and positions in 15 of 15 | `test-pptx-rust.ts`, worst pixel match 57 dB |
| Excel to PDF: 58 files compared, 0 different cell text, 1 fell back to TypeScript | `test-xlsx-rust.ts`, pixel match 57-90 dB |
| HTML to PDF writer: same pages and words in 8 of 8 | `test-html-rust.ts`, worst 59 dB |
| Hindi, Greek, Cyrillic and Chinese watermarks, page numbers and Word files work through Rust in the real app | `scripts/e2e/unicode-watermark.mjs`, 6 of 6 |
| 27 of 29 scripted tool checks pass in the real app; the 2 others are harness limits, not bugs | `all-tools.mjs` (see below) |

Do not claim: that Rust is faster for every tool (it is not, see Speed), that the generated PowerPoint opens in real PowerPoint (not checked), or that Edit PDF is on Rust (it is not).

## Tests run, newest first

### 2026-11-12 (evening) · the published beta.3 installer itself

Downloaded `IHatePDF-Setup.exe` from the `v2.0.0-beta.3` pre-release (built by CI, 25.9 MB), installed it (NSIS, current user; the exe reports 2.0.0-beta.3), launched it with the WebView2 debug port and ran the same three scripts. Same results as the local build: `all-tools.mjs` 27 of 29 (same two harness failures, `compress` upload timeout and `autoSave` download event), `unicode-watermark.mjs` 6 of 6, `pdf-to-ppt-native.mjs` 3 of 3. Same expected fallback warnings only (rotated page, form XObject, damaged file for Repair). Note: `/S` alone left the installer window open here; `/S /D=<folder>` installed cleanly.

### 2026-11-12 (afternoon) · installed-app pass and Edit PDF text analysis in Rust

| Test | What it checks | Result |
|---|---|---|
| `all-tools.mjs` with `E2E_CDP` on a fresh release build | 29 scripted checks, every tool end to end in the real app | 27 pass. `compress` fails on harness upload timeout (its 44 MB input is over the debug port's upload limit; Compress is checked separately below). `autoSave` fails because it waits for a browser "download" event that the desktop app never fires (it saves to a folder instead). Neither is a product bug |
| `tauri.mjs` (Compress smoke test in the app) | Compress runs on Rust and saves | pass (sample-multi 2.4 KB, saved) |
| `unicode-watermark.mjs` | Watermark with Hindi, Greek and Chinese text, then Word to PDF on Hindi, Greek+Cyrillic and Chinese .docx, in the app; fails on any Rust-declined warning or missing text | 6 of 6 pass. Closes the open question "does the Rust engine find the embedded fonts in the installed app": yes |
| `pdf-to-ppt-native.mjs` | PDF to PowerPoint fully native (Rust text boxes + PDFium backgrounds + Rust slide pictures + Rust .pptx) on 3 PDFs; fails on fallback warnings or a deck without text | 3 of 3: 4 slides/11 text runs, 2/6, 10/257 |
| `test-editpdf-rust.ts` (new Rust port of the Edit PDF text analysis, `editpdf.rs`) | Per page: number of boxes and every field (text lines, font name, size, colour, bold/italic, alignment, rotation exact; x/y/width/height/line height within 0.01 pt) | Our corpus: 137 pass, 470 pages, 14,438 boxes. Real-world corpus (105 PDFs, 1,141 pages, 6,629 boxes): 105 pass. 0 fail, 0 fallback in both |
| `xlsx` re-run after removing a dead assignment | no behaviour change | 58 compared, 0 different cell text, same as before |
| `npm test` | TypeScript suites | 17/17, 33/33, 5/5 |
| `npx tsc --noEmit`, `cargo build --release` | type and compile checks | clean, no warnings |

**Speed of the text analysis (measured, not assumed):** the first Rust version took 2.4 s for the 137-file set against 0.9 s for TypeScript. Timing it per stage showed the cause: three regular expressions were being compiled for every text box. After compiling them once, Rust takes 1.1 s against 1.0 s, so the two are level. The value of this port is not speed: PDF to PowerPoint no longer needs a Web Worker, a second copy of the PDF in memory, or the TypeScript engine on the common path.

### 2026-11-12 (earlier) · Office conversions, Unicode fonts and PowerPoint writer

| Port | Comparison | Result |
|---|---|---|
| Unicode font layer (Greek, Cyrillic, Devanagari, CJK in Watermark and Page numbers) | `test-stamp-rust.ts`, TS worker vs Rust, MuPDF pixels and words, 19 cases | 19 of 19. CJK and Cyrillic 99 dB, Greek 74.7 dB, Devanagari 79-84 dB. Devanagari word order is not compared (TS writes a vowel sign before its consonant, Rust keeps logical order) |
| Word to PDF | `test-docx-rust.ts`, 6 generated + 5 real files | 10 of 10 same pages and words; 61-99 dB |
| PDF to PowerPoint backgrounds (PDFium text removal vs TS engine) | `test-strip-rust.ts` | 0 text characters left in both and 0.00% pixel difference on 3 PDFs; `complex.pdf` has text inside a form XObject, so Rust errors and TypeScript runs (checked) |
| PDF to PowerPoint writer + slide rendering | `test-pdfppt-rust.ts`, python-pptx compare | slide size, shape order, picture hash, text, run formatting, alignment, spacing, positions, rotation identical to pptxgenjs on 3 PDFs; package well-formed |
| HTML to PDF writer | `test-html-rust.ts`, 8 display lists | 8 of 8; worst 59.2 dB |
| PowerPoint to PDF | `test-pptx-rust.ts`, 15 files | 15 of 15; worst 57.1 dB |
| Excel to PDF | `test-xlsx-rust.ts`, 59 files | 58 compared, 0 different cell text, 1 fell back (a `0E+00` number format Rust declines on purpose) |

### Earlier in 2.0 (from `WINDOWS_TESTS.md`)

- Compress, Rust vs the 1.4.0 TypeScript engine: image quality (SSIM) equal or better at every level; speed in the app 811 ms vs 2,283 ms on a 10 MB scan, 91 vs 313 ms on a photo; extra peak memory +130 MB vs +706 MB.
- Repair (36 damaged files): same pages in 30, PDFium better in 1, TypeScript repair takes over in 5.
- PDF to Markdown/Word/Excel with PDFium text: 17 of 18 outputs identical to the pdf.js route.
- Startup: Electron 1,193 ms / 408 MB vs Tauri 909 ms / 423 MB (WebView2 dominates memory).

## Bugs the tests found and what was done

| Where | Bug | Fix |
|---|---|---|
| TypeScript PowerPoint to PDF (existing since 1.x) | JPEG pictures stored uncompressed in a .pptx were silently dropped (pdf-lib ignores a view's offset into the zip buffer) | worker passes a copy; both engines now draw them |
| TypeScript Word to PDF | A tab character inside a run crashed the conversion | Rust draws it as a space; the TS engine is unchanged |
| Rust Greek watermark | 46 dB against TypeScript | kerning was on for Liberation Sans, the TS tools do none; switched off, 74.7 dB |
| Rust Devanagari text extraction | stray control characters | better ToUnicode map (cluster text, reverse cmap, U+FEFF for helper glyphs) |
| Compress (earlier) | wrong `/Length` on re-encoded images | fixed |
| App shell (earlier) | blob results never saved in the Tauri shell; PDFium initialised twice | fixed |
| Rust Edit PDF text analysis | 3 regexes compiled per text box made it 2.4x slower than TypeScript | compiled once, now level |

## Known limits and not tested

- **Not checked**: Windows SmartScreen / unsigned-installer behaviour for other users; opening the Rust-written .pptx in real PowerPoint or LibreOffice (neither installed here); real Office-made decks with complex masters; very large workbooks; spreadsheets saved by LibreOffice or Google Sheets; Edit PDF's click-and-retype editing (still TypeScript).
- Rust declines to TypeScript in these cases: encrypted or unreadable PDFs, text inside a form XObject (backgrounds), rotated pages (PDFium text extraction for Word/Excel/Markdown), GIF/BMP/WebP pictures in Word, `.xls`/`.ods`/`.csv` and date-typed or exotic-format cells in Excel, unknown HTML display-list items.
- The Edit PDF *editing* half (`applyPageEdits`, ~700 lines, keeps one live model per page in the editor) was not ported: it has no speed or memory problem and porting it would change how the editor holds state.
- Left on TypeScript on purpose: Protect, Unlock, Forms, PDF/A, the Compare word diff. Skipped by instruction: Share to phone, the usage log.
- `all-tools.mjs`: `compress` and `autoSave` fail for harness reasons listed above.

## Commands (all from the repo root)

```bash
cd crates/ihp-core && cargo build --release          # once, builds the CLI bins used by the tests
PY=py PYTHONIOENCODING=utf8 npx tsx scripts/test-docx-rust.ts
PY=py PYTHONIOENCODING=utf8 npx tsx scripts/test-pptx-rust.ts
PY=py PYTHONIOENCODING=utf8 npx tsx scripts/test-xlsx-rust.ts
PY=py PYTHONIOENCODING=utf8 npx tsx scripts/test-html-rust.ts
PY=py PYTHONIOENCODING=utf8 npx tsx scripts/test-stamp-rust.ts
npx tsx scripts/test-editpdf-rust.ts                 # add directories or files to test your own PDFs
# the real app: build, launch with a debug port, drive it
npm run build && (cd src-tauri && cargo build --release)
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 src-tauri/target/release/ihatepdf.exe
E2E_CDP=http://127.0.0.1:9222 node scripts/e2e/all-tools.mjs
E2E_CDP=http://127.0.0.1:9222 PY=py node scripts/e2e/unicode-watermark.mjs
E2E_CDP=http://127.0.0.1:9222 node scripts/e2e/pdf-to-ppt-native.mjs
```
