# Checkpoint: 2.0 Rust port (first written 2026-11-11 at ~90% usage; updated 2026-11-12, context limit)

Branch `claude/rust-port`, code is at **2.0.0-beta.2** (commit 8061210); only **v2.0.0-beta.1** is published as a release so far. To continue, say "continue from docs/CHECKPOINT.md".

## LATEST (2026-11-12, end of session) - read this first; the "Next, in order" list further down is partly stale

- **v2.0.0-beta.3 is published (pre-release, workflow run 43199851941; 1.4.0 stays "Latest"; nothing on main).** About 22 of 28 tools run on Rust first with TypeScript fallback: everything in the lists below plus Word/PowerPoint/Excel/HTML to PDF, PDF to PowerPoint (fully native) and the Unicode font layer. Recall sheet of every test and number: `docs/testing/TEST_LOG.md`.
- **Tested on the published CI installer** (installed, run over the WebView2 debug port): `all-tools.mjs` 27/29 (the 2 failures are harness limits: `compress` upload timeout, `autoSave` download event), `unicode-watermark.mjs` 6/6, `pdf-to-ppt-native.mjs` 3/3. Plain `/S` leaves the NSIS window open here; use `/S /D=<folder>`.
- **2.0.0 built and installed locally (2026-11-19, NOT committed, NOT pushed, NOT a GitHub release):** version set to 2.0.0 in package.json, tauri.conf.json, Cargo.toml; `FinalApp/IHatePDF-Setup.exe` (27.9 MB, unsigned) installed per-user in `%LOCALAPPDATA%\Programs\IHatePDF`; the 1.4.0 install, its Public Desktop shortcut, the old `Desktop\IHatePdf` project and `PropPres\_installers1.4.0` installer were deleted at Dev's request. Installed build: all-tools 27/29 (same 2 harness limits), ppt-native 5/5, edit-native 2/2, unicode 6/6, pdf-to-ppt 3/3, share-wifi PASS. Also new: PowerPoint charts (`pptx/chart.rs`: bar/column/stacked/line/area/pie), Share to phone Wi-Fi mode (`src-tauri/src/share.rs`, LAN link + token + timer + folder zip; hotspot and Bluetooth return a not-in-this-build message; NOT tried on a real phone). Left: commit/push/release (Dev's call), signing, Share to phone on a phone, hotspot/Bluetooth.
- **PowerPoint to PDF was rewritten (2026-11-19, NOT committed, NOT in a release):** Dev reported wrong colours/elements; the old regex-level engines (TypeScript and its Rust port) are replaced on the Rust side by a DrawingML renderer, `crates/ihp-core/src/pptx/` (details and numbers: `docs/testing/TEST_LOG.md` newest entry; measured against PowerPoint's own PDF: 79.3 -> 2.0 on PowerPoint-built decks, 26.8 -> 8.2 on Dev's real decks). TypeScript engine unchanged, still the fallback. Missing: charts, EMF/WMF, 3D/glow/reflection, WordArt effects, SmartArt untested. `test-pptx-rust.ts` (TS vs Rust parity) removed on purpose. src-tauri release profile is now `panic = "unwind"` so the renderer can catch its own panics.
- **Edit PDF editing half is now on Rust too (2026-11-12 night, NOT committed, NOT in a release):** `crates/ihp-core/src/editpdf/apply.rs` + provenance in `editpdf.rs`, `edit_apply` command, `features/editPdf/editApply.native.ts`, `nativeFirst` around the editor worker (PREVIEW/EXPORT). A/B `scripts/test-editapply-rust.ts`: 805/805 edited pages match TypeScript (words + pixels, worst 0.16%), 276/276 on real PDFs; installed-style app `scripts/e2e/edit-native.mjs` 2/2; `all-tools.mjs` 27/29 (same 2). Falls back to TypeScript for text needing an embedded Unicode font, password files, previews of files over 40 MB. Not verified: added PNG pictures via Rust in the app, Acrobat opening the output.
- **Still TypeScript on purpose:** Protect, Unlock, Forms, PDF/A, Compare word diff. Skipped by instruction: Share to phone, usage log.
- **Not verified:** LibreOffice (real PowerPoint opens the Rust .pptx fine, 2026-11-12 night); complex Office decks; very large workbooks; LibreOffice/Google Sheets xlsx.
- **Machine note:** the 1.4.0 install (Program Files, Public Desktop shortcut) is the user's real one; the beta test install was uninstalled again.
- **Architecture fact for any write-up:** native Rust in Tauri (no wasm); web app unknown/not part of 2.0. Numbers for a LinkedIn-style post are in `TEST_LOG.md`; the open items there are timeline and Dev's own words (do not invent).
- **Possible next work:** merge `claude/rust-port` to main (user's call only), a stable 2.0.0 after real-PowerPoint check, a beta.4 pre-release carrying the Edit PDF port (commit + run the Windows installer workflow by hand), signed installer.

## State

- Tauri shell + Rust core (`crates/ihp-core`) in; Electron removed. Installer 25 MB, per-user NSIS.
- In Rust (13 tools): Compress, Merge, Split, Organize, Rotate, Crop, Images to PDF, Scan to PDF, PDF to JPG, Redact, Watermark, Page numbers, Sign. Also: PDFium page count at ingestion + thumbnails, memory watchdog (`src-tauri/src/watchdog.rs`).
- All 27 working tools pass end to end in the installed app (`E2E_CDP=http://127.0.0.1:9222 node scripts/e2e/all-tools.mjs ...`), `npm test` green, Rust tests green (see HANDOFF.md "Rust engines and the native adapter" for how to port a tool and test it).
- Share to phone and the usage log are NOT in 2.0 (user said to skip them).

## Decided: stays on the TypeScript engines on purpose

- **Protect / Unlock**: security-critical (AES-256 R6, RC4, AES-128, tested against independent encryptors); no measured speed or memory problem; a rewrite adds risk. Revisit only if lopdf's crypto passes the same fixtures (`test-fixtures/complex/aes128_user_pw.pdf`, `rc4_owner_only.pdf`, files from the TS Protect) and MuPDF opens the output with the password.

## Done since the first checkpoint (2026-11-12)

- **Repair**: PDFium opens the damaged file tolerantly and saves a clean copy (`render::repair`, `repair_pdf`); TypeScript runs when PDFium can't open it. A/B on 36 damaged files (`scripts/test-repair-rust.ts`): same pages in 30 cases, Rust better in 1, and the 5 "worse" ones are Rust failures that fall back to TS, so the combination never recovers less.
- **Forms and PDF/A: kept on TypeScript on purpose** (appearance-stream generation and compliance details; tiny files, no measured problem).
- Single-page previews (`usePdfRenderer.renderThumbnail`) use PDFium.
- **Compare**: the visual overlay pages are drawn by PDFium; the word diff stays on pdf.js ON PURPOSE (PDFium orders text by its own rules: 6 changes vs 2 on the fixtures; MuPDF and pdf.js agree on 2).
- **v2.0.0-beta.2 IS published (pre-release, 2026-11-12)**; old text follows for history: it was not published yet: the by-hand "Windows installer" run 43097579444 ended `startup_failure`, and two push runs (43097578216, 43096738017) sat `queued` for 5+ hours (looks like a GitHub Actions/runner problem, not our code: earlier runs on this branch succeeded). FIRST THING TO DO: `gh run list -R Burthcer/IHatePDF --workflow windows-installer.yml`, cancel stale queued runs, re-run `gh workflow run windows-installer.yml -R Burthcer/IHatePDF --ref claude/rust-port`, confirm release `v2.0.0-beta.2` is a pre-release. If startup_failure repeats, check the Actions tab / workflow syntax / billing limits.
- Office to PDF (Word/PowerPoint/Excel/HTML) and Edit PDF: judged not worth porting without a Unicode font embedder/shaper in Rust (the same gap that makes Watermark/Page numbers fall back for non-Latin text): the TypeScript versions take about a second per file and the risk (the user's earlier picture/layout bugs) outweighs the gain. If you want them anyway: build the font layer first (`ttf-parser` + `subsetter` + `rustybuzz`), then port docx, with pixel A/B against the TS output as in `scripts/test-stamp-rust.ts`.
- **PDF to Markdown/Word/Excel**: text runs and picture boxes now come from PDFium (`render::page_runs`, `pdf_runs`, `src/services/textLayoutNative.ts`) into the unchanged layout code (`analyzeLayout`); falls back to pdf.js on rotated pages. A/B harness: `scripts/e2e/layout-ab.mjs` + `scripts/layout-ab-compare.py`. If the A/B shows a real difference, keep pdf.js and drop `useLayoutAnalysis`'s native branch.

- **HTML to PDF writer DONE in Rust (html.rs, A/B 8/8, worst 59 dB; layout capture stays in the browser; TS fallback). NOT verified in the installed app** (packed job file via stageInput + fontAssets).

- **Installed-app E2E done for all the new Rust paths (2026-11-12 afternoon)**: Unicode fonts via `asset_resolver` work (Watermark, Word to PDF), PDF to PowerPoint is fully native, `all-tools.mjs` 27/29 (the 2 are harness limits). **PDF to PowerPoint text boxes DONE in Rust (`editpdf.rs`, 242 PDFs / 21,067 boxes identical, speed level)**. Only Edit PDF's editing half (`applyPageEdits`) remains on TS, on purpose. Recall sheet of all tests: `docs/testing/TEST_LOG.md`.

## Next, in order (code first; each needs a Rust-vs-TS comparison test before it ships, TS stays as fallback)

1. **PDF to PowerPoint**: backgrounds now via PDFium (`render::strip_text`, `strip_pdf_text`, `features/pdfToPpt/strip.native.ts`; 0.00% pixel diff vs TS, falls back on form-XObject text). Text boxes stay on the TS Edit-engine analysis (needs colour/rotation/alignment PDFium runs lack): that part waits for the Edit engine port. Writer + slide rendering now in Rust too (`pptx_out.rs`, `build_pptx`, `buildPptx.native.ts`; structurally identical to pptxgenjs on 3 PDFs, see WINDOWS_TESTS). NOT verified: real PowerPoint/LibreOffice opening, the installed app (E2E). Text-box extraction is still the TS Edit engine.
2. **Word to PDF DONE in Rust (docx.rs, A/B 10/10; not yet in installed app).** Still to do, same method: **Excel to PDF DONE in Rust (xlsx.rs, SheetJS reading + SSF formatter ported, A/B 58/58 same cell text and pages, PSNR >= 56.9 dB; NOT verified in the installed app, nor on LibreOffice/Google Sheets-written files)**; still to do: **PowerPoint / HTML to PDF**: port the OOXML parsing by hand (no Rust equivalent of the libraries); picture fidelity tests first (`scripts/test-docx-images.ts`, quality fixtures).
3. **Edit PDF engine** (`features/editPdf/engine`, ~5k lines): largest; last.
4. Later: Share to phone (Wi-Fi server + zip, hotspot via WinRT, Bluetooth OBEX), usage log.

- **PowerPoint to PDF DONE in Rust (pptx.rs, A/B 15/15, worst 57 dB; TS fallback; also fixed the TS stored-JPEG drop).** NOT verified: installed app (E2E), real Office decks beyond the fixtures.

## Known gaps / ideas

- Unicode font layer DONE in Rust (`fonts.rs`, 2026-11-12): Watermark and Page numbers use it for Greek/Cyrillic/Devanagari/CJK (A/B passes). Verify in the installed app that `asset_resolver` finds the fonts. Next: use it from Office to PDF (item 2).
- Rust tools read whole files (cap 1 GB in `nativeTools.MAX_NATIVE_BYTES`); bigger go to TS.
- Opening a 10,000-page file: first thumbnail 9.4 s vs 7.3 s with pdf.js (mostly the test harness upload); could skip the staging copy by using native file dialogs/paths.
- Idle memory is unchanged vs Electron (WebView2 renders the same page).
- CI (`windows-installer.yml`) now builds with Rust; first CI run on the branch is the first real test of that.
