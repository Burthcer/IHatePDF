# Checkpoint: 2.0 Rust port (first written 2026-11-11 at ~90% usage; updated 2026-11-12, context limit)

Branch `claude/rust-port`, code is at **2.0.0-beta.2** (commit 8061210); only **v2.0.0-beta.1** is published as a release so far. To continue, say "continue from docs/CHECKPOINT.md".

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

## Next, in order (code first; each needs a Rust-vs-TS comparison test before it ships, TS stays as fallback)

1. **PDF to PowerPoint**: backgrounds now via PDFium (`render::strip_text`, `strip_pdf_text`, `features/pdfToPpt/strip.native.ts`; 0.00% pixel diff vs TS, falls back on form-XObject text). Text boxes stay on the TS Edit-engine analysis (needs colour/rotation/alignment PDFium runs lack): that part waits for the Edit engine port. Still to do: run it in the installed app (E2E).
2. **Word / PowerPoint / Excel / HTML to PDF**: port the OOXML parsing by hand (no Rust equivalent of the libraries); picture fidelity tests first (`scripts/test-docx-images.ts`, quality fixtures).
3. **Edit PDF engine** (`features/editPdf/engine`, ~5k lines): largest; last.
4. Later: Share to phone (Wi-Fi server + zip, hotspot via WinRT, Bluetooth OBEX), usage log.

## Known gaps / ideas

- Watermark and Page numbers: non-WinAnsi text falls back to TS (Rust has no Unicode font embedding yet).
- Rust tools read whole files (cap 1 GB in `nativeTools.MAX_NATIVE_BYTES`); bigger go to TS.
- Opening a 10,000-page file: first thumbnail 9.4 s vs 7.3 s with pdf.js (mostly the test harness upload); could skip the staging copy by using native file dialogs/paths.
- Idle memory is unchanged vs Electron (WebView2 renders the same page).
- CI (`windows-installer.yml`) now builds with Rust; first CI run on the branch is the first real test of that.
