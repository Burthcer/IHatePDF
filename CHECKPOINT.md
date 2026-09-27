# Work-in-progress checkpoint

Branch: `claude/bold-cori-o7rx16`. Paused at the user's request (usage limit).

## Done in this round
- Compressor rewritten (`src/features/compress/compress.worker.ts` + new `imageCodec.ts`).
  - It now decodes and re-encodes every image type: DCT, JPX, CMYK, ICC, Indexed, 16-bit, SMask'd, and predictor-Flate. Before, it skipped most of them, which is why a 33 MB PDF came back unchanged.
  - Downsampling is DPI-aware and uses each image's displayed size.
  - Duplicate streams are merged and unreachable objects removed.
- **Custom size** mode: the user enters a target in MB or KB (shrink only). A binary search over a 29-step dpi/quality ladder finds the best quality that fits.
  - `scan_photos.pdf` (35.5 MB): target 10 MB → 8.63 MB, 2 MB → 1.95 MB, 400 KB → 354 KB.
  - `mixed_images.pdf` (88.6 MB): target 2 MB → 1.79 MB.
- Visual check: original vs compressed differs by under 0.6/255 mean per page (`scripts/e2e/renderCompare.mjs`).
- pdf.js 6 needs `Map#getOrInsertComputed`, which older Chromium/Electron lack. Polyfilled in `src/services/polyfills.ts`, the app entry, and a wrapped pdf.js worker (`src/services/pdfjs.worker.ts`).
- Playwright e2e harness in `scripts/e2e/` (needs `npx vite preview --port 4173`).

## Still to do (resume here)
1. `npm test` fails first on missing fixtures. Run `npx tsx scripts/generateTestFixtures.ts`, then `npm test` again, and fix any failures.
2. Browser e2e for every tool with dummy docs, including editor interactions. Fix what breaks.
3. Auto-save: after any tool result, auto-name and save after a 5 s countdown, with a "Rename…" button.
4. Electron (`electron/main.cjs`):
   - Quit fully when the window is closed.
   - Show the window fast (`show:false` + `ready-to-show`, backgroundColor).
   - Add a `will-download` handler that auto-saves to Downloads/IHatePDF.
5. Build `IHatePDF-Setup.exe` (`npm run build:exe`, output goes to `FinalApp/`). Consider a GitHub Actions windows build.
6. Update README.md, HANDOFF.md, docs/*.md. Delete this file.
