# IHatePDF 2.0 benchmarks

What was measured when IHatePDF moved from Electron + TypeScript (1.4.0) to Tauri + a Rust core (2.0.0), how, and what the numbers do **not** say.

| File | What it is |
|---|---|
| [`index.html`](index.html) | One self-contained page with bar charts for every comparison (open it in a browser; works offline, light and dark) |
| [`benchmarks.json`](benchmarks.json) | **All the data**, with units, "lower is better" flags, the script that produced each number, caveats and reproduction commands. The single source of truth |
| [`benchmarks.csv`](benchmarks.csv) | The same measurements as a flat table (one row per measurement) for spreadsheets or a website |
| [`../../scripts/build-benchmarks.py`](../../scripts/build-benchmarks.py) | Rebuilds the CSV and the page from the JSON: `python scripts/build-benchmarks.py` |
| [`../testing/TEST_LOG.md`](../testing/TEST_LOG.md) | The recall sheet behind the numbers: what each test was, how it ran, what came out |
| [`../testing/WINDOWS_TESTS.md`](../testing/WINDOWS_TESTS.md) | The full run-by-run notes, newest first |

## Headline

- Installer **123.8 MB → 27.9 MB**.
- Compress **2.8x to 3.4x faster** in the app on scans and photos (2,283 → 811 ms, 313 → 91 ms), image quality (SSIM) equal or better at every level, extra peak memory **+706 MB → +130 MB**.
- PowerPoint → PDF measured against the PDF PowerPoint itself writes: mean page difference **79.3 → 2.0** (decks built in PowerPoint) and **26.8 → 8.2** (30 real lecture decks).
- Every tool moved to Rust was compared with the old TypeScript engine on the same inputs first (text boxes: 21,067 identical; Edit PDF: 805 of 805 pages identical; Word 10 of 10; Excel 58 of 58 cell texts), and the old engine stays as the fallback.

## Method

1. **Rust vs TypeScript on the same input.** Both engines run on the same files. Outputs are compared with MuPDF (page count, extracted words, and pixel similarity as PSNR, or a mean pixel difference), or field by field for data outputs.
2. **Against PowerPoint itself.** For PowerPoint → PDF the reference is the PDF that real PowerPoint writes for the same deck (COM automation, `scripts/make-ppt-decks.ps1`). Each sampled page is scored as the mean absolute grey difference (0 to 255) at 40 dpi. Decks: 10 built in PowerPoint (8 Office themes, shapes and effects, backgrounds/tables/pictures) and 30 of the author's real lecture decks (not committed).
3. **In the installed app.** The Windows installer is installed and driven over the WebView2 debug port with Playwright (`scripts/e2e/`).
4. **Speed and memory** are click-to-result times and working-set sizes on one laptop (Windows 11 build 26200, Intel Core Ultra 9 185H, 31.4 GB), medians where a median is stated.

## What the numbers do not say

- It is **one machine and one user**. Treat the numbers as indicative.
- **Rust is not faster for everything.** The text analysis is level with TypeScript (1.1 s vs 1.0 s for 137 PDFs), idle memory is the same (WebView2 draws the same page), and the Edit PDF timing compares Rust's core time with TypeScript's time including file loading.
- Protect, Unlock, Forms, PDF/A and the Compare word diff stay on TypeScript on purpose; Unicode text in Edit PDF and password-protected files fall back to TypeScript.
- The PowerPoint score is a pixel measure: two identical-looking pages still score about 2 to 8. On real decks the remaining gap is mostly fonts the test machine does not have.
- Charts cover bar, column, stacked, line, area and pie only; EMF/WMF pictures, 3D, glow and WordArt effects are not drawn; SmartArt is untested; the output was checked in real PowerPoint but not in LibreOffice.
- Share to phone: Wi-Fi mode only, not yet tried on a real phone. The PC hotspot, Bluetooth and usage log from 1.4.0 are not in 2.0.
- The installer is not code-signed.

## Reproduce

```bash
cd crates/ihp-core && cargo build --release
PY=py PYTHONIOENCODING=utf8 npx tsx scripts/test-editapply-rust.ts
PY=py PYTHONIOENCODING=utf8 npx tsx scripts/test-pptx-real.ts      # needs PowerPoint for the references
E2E_CDP=http://127.0.0.1:9333 node scripts/e2e/all-tools.mjs        # installed app started with --remote-debugging-port=9333
```
