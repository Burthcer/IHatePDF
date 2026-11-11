# Checkpoint: 2.0 Rust port (written 2026-11-11, usage at ~90% of the 5-hour limit)

Branch `claude/rust-port`, published as pre-release **v2.0.0-beta.1**. To continue, say "continue from docs/CHECKPOINT.md".

## State

- Tauri shell + Rust core (`crates/ihp-core`) in; Electron removed. Installer 25 MB, per-user NSIS.
- In Rust (13 tools): Compress, Merge, Split, Organize, Rotate, Crop, Images to PDF, Scan to PDF, PDF to JPG, Redact, Watermark, Page numbers, Sign. Also: PDFium page count at ingestion + thumbnails, memory watchdog (`src-tauri/src/watchdog.rs`).
- All 27 working tools pass end to end in the installed app (`E2E_CDP=http://127.0.0.1:9222 node scripts/e2e/all-tools.mjs ...`), `npm test` green, Rust tests green (see HANDOFF.md "Rust engines and the native adapter" for how to port a tool and test it).
- Share to phone and the usage log are NOT in 2.0 (user said to skip them).

## Decided: stays on the TypeScript engines on purpose

- **Protect / Unlock**: security-critical (AES-256 R6, RC4, AES-128, tested against independent encryptors); no measured speed or memory problem; a rewrite adds risk. Revisit only if lopdf's crypto passes the same fixtures (`test-fixtures/complex/aes128_user_pw.pdf`, `rc4_owner_only.pdf`, files from the TS Protect) and MuPDF opens the output with the password.

## Next, in order (code first; each needs a Rust-vs-TS comparison test before it ships, TS stays as fallback)

1. **Forms** (`forms.worker.ts`, 127 lines): field fill + flatten; needs appearance streams.
2. **Repair** (`repair/salvage.ts`): try lopdf's tolerant load + page rebuild; compare success rate against the TS repair on truncated / bad-xref / junk-before-header files before switching.
3. **PDF/A**, **Compare** (needs PDFium text extraction + diff).
4. **PDF to Markdown / Word / Excel / PowerPoint**: text layout recovery (`textLayout.ts`, `layoutToMarkdown.ts`) on PDFium char data.
5. **Word / PowerPoint / Excel / HTML to PDF**: port the OOXML parsing by hand (no Rust equivalent of the libraries); picture fidelity tests first (`scripts/test-docx-images.ts`, quality fixtures).
6. **Edit PDF engine** (`features/editPdf/engine`, ~5k lines): largest; last.
7. Later: Share to phone (Wi-Fi server + zip, hotspot via WinRT, Bluetooth OBEX), usage log.

## Known gaps / ideas

- Watermark and Page numbers: non-WinAnsi text falls back to TS (Rust has no Unicode font embedding yet).
- Rust tools read whole files (cap 1 GB in `nativeTools.MAX_NATIVE_BYTES`); bigger go to TS.
- Opening a 10,000-page file: first thumbnail 9.4 s vs 7.3 s with pdf.js (mostly the test harness upload); could skip the staging copy by using native file dialogs/paths.
- Idle memory is unchanged vs Electron (WebView2 renders the same page).
- CI (`windows-installer.yml`) now builds with Rust; first CI run on the branch is the first real test of that.
