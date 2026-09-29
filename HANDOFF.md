# Developer handoff — IHatePDF

IHatePDF is a PDF tool suite (28 tools) that runs entirely on the user's machine:
- a React + TypeScript app built with Vite;
- the PDF work runs in Web Workers on `pdf-lib` and `pdf.js`;
- it is packaged for Windows with Electron and electron-builder (NSIS).

There is no backend. No tool makes a network request, and the app works offline.

## Ground rules

- **Never load PDFs with `PDFDocument.load` directly.** Use `openPdf()` from `src/services/pdfLoader.ts` (details below).
- **Never open pdf.js documents directly.** Use `openPdfJsDocument()` from `src/services/pdfWorkerSetup.ts` (legacy build, local CMaps/fonts/WASM).
- **Never read a whole input into memory.** `PDFFile.data` is a `Blob` (the picked `File`, so it stays on disk). Workers get it as a `PdfInput`; `openPdf()` loads inputs of 1 MB or more lazily, and results go out through the task's sink (`emitPdf` / `emitBytes` / `emitSequential` in `services/workerEmit.ts`), never as one big buffer.
- **Heavy work goes in a worker.**
  - One-shot tools use `useToolRunner` (on top of `useWorkerBridge`) and spread `runner.layout` into `<ToolLayout>`.
  - Workers that need concurrent calls use `WorkerClient`.
- **Coordinates are "as displayed".** Everything the user places on a page uses rotation and CropBox-applied, top-left-origin coordinates, the same as pdf.js's `PageViewport`. `services/pageOverlay.ts` and `editPdf/engine/geometry.ts` convert them to PDF space.
- **Tool metadata lives only in `src/constants/tools.ts`.** Routing is hash-based (`#/merge`), and views are lazy-loaded in `App.tsx`.

## Code map

```
src/
  App.tsx, main.tsx            entry, hash router (main.tsx installs polyfills first)
  components/
    ui/                        design-system primitives (Button, Field, Segmented, Modal, …)
    layout/ToolLayout.tsx      workspace + options panel + run / progress / result (AutoSave)
    common/                    Dropzone, AutoSave, PageThumb, PositionGrid, Header, Footer, …
    home/Home.tsx              tool catalog + open-files-first flow
    convert/                   shared Office→PDF view and structure preview
  features/<tool>/             <Tool>View.tsx + <tool>.worker.ts for each of the 28 tools
    editPdf/engine/            the text-editing engine (see below)
    editPdf/editor/            PageCanvas (overlays, drag, inline editor), Inspector
    compress/imageCodec.ts     decode any PDF image XObject to RGBA
    repair/salvage.ts          byte-level recovery for unparseable files
  hooks/                       useToolRunner, useWorkerBridge, useFileIngestion (password prompt),
                               usePageThumbnails, usePdfRenderer, useLayoutAnalysis, useTheme
  services/                    pdfLoader, pdfSecurity/legacyCrypto/pdfCrypto (encryption),
                               pdfWorkerSetup + pdfjs.worker + polyfills (pdf.js), fonts,
                               pageOverlay, textLayout + layoutToMarkdown, pageRanges,
                               imagePrep, fileNames, memoryManager, workerClient, zip*
  types/                       pdf.ts (PDFFile, tool types), worker.ts (RPC envelopes, payloads)
electron/                      main.cjs (app:// protocol, window, downloads), preload.cjs,
                               share.cjs + zip.cjs + hotspot.cjs + bluetooth.cjs (Share to phone)
build/                         app icon (icon.ico / icon.png)
scripts/                       test suites, fixture generators, e2e/ browser + Electron tests
docs/                          release notes, test report, publishing guide, screenshots/
```

## Worker protocol

The main thread sends `{ id, action, payload }` (`WorkerRequest`). The worker replies with any number of `{ type: 'PROGRESS', payload: { id, progress, stage } }` messages, then one `{ type: 'RESPONSE', payload: { id, success, data | error } }`.

`ArrayBuffer`s are transferred, never copied: slice before sending if the caller still needs its copy. Results are `{ fileName, buffer | output, size, pageCount?, note?, mimeType? }`. `note` is shown under the result.

Workers are written with `serveTask(action, (payload, ctx) => …)` (`services/workerTask.ts`), which handles the envelope, progress and friendly errors (`services/friendlyErrors.ts`). Besides PROGRESS and RESPONSE:
- **Output** (`services/workerOutput.ts`): `ctx.sink()` streams the result as `OUTPUT` chunks (batched to ~4 MB, at most 2 in flight, each acknowledged with `OUTPUT_ACK`). The page's `OutputCollector` (`services/toolOutput.ts`) writes them to a temp file on the desktop, or to a Blob in a browser; the result then carries `output` instead of `buffer`.
- **Questions** (`ctx.ask(what, data)`): the worker asks the page for something only it can make (Redact asks for each redacted page's image, one at a time, while `saveSequential` writes the file front to back). The page answers through `useWorkerBridge`'s `onAsk`.

## Memory

**Budget (the fail-safe).** `electron/memoryGuard.cjs` sets a budget from the PC's RAM: max(1 GB, min(50%, RAM − 3 GB, 16 GB)), overridable with `IHP_MEMORY_BUDGET_MB`. The budget is for the *job*, not the app: twice a second the watchdog sums the app's processes (`app.getAppMetrics()`) and measures the growth since the first job started (the page reports its job count with `ihp:mem-jobs`), or, with no job running, since the lowest point of the last minute. So the app's idle memory (0.5–0.9 GB depending on Windows) never counts. `levelFor()` turns growth into a level sent as `ihp:mem`: *high* from 70% of the budget (tools work in smaller pieces; `SystemNotice` shows "Low on memory: taking longer"), *over* above the budget (jobs pause at their next `memoryCheckpoint()` / `startJob().checkpoint()`, drop caches registered with `onMemoryPressure`, and force garbage collection: the app runs with `--expose-gc`), and *critical* only as a last resort: Windows nearly out of memory while the job holds over 128 MB (`reason: 'system'`), still over the budget after 8 s of pausing, or twice the budget (`reason: 'too-big'`). On *critical*, `services/memoryGuard.ts` cancels running jobs (`MemoryLimitError`, "Stopped to protect this PC"). The page answers each *over*/*critical* report (`ihp:mem-ack`); a page that stops answering while over the budget is restarted after 1 s (`?recovered=memory`), one that answers but can't get out of *critical*, after 3 s. Thumbnails don't render while a job runs or memory is over, and pdf.js uses its own JPEG decoder instead of the browser's `ImageDecoder` on PCs with a budget under 2 GB (the browser's decoder keeps each decoded page, 35 MB for a 300 dpi scan, in shared memory).

**Crashes.** `render-process-gone` reloads the window with `?recovered=crash`; `components/common/SystemNotice.tsx` explains what happened. Three crashes within a minute show an error and quit.

**Big files.** `services/byteSource.ts` + `lazyPdf.ts` let pdf-lib parse a PDF while reading stream contents from the Blob only when they're written out; `pdfStreamSave.ts` writes a document in chunks (`saveToSink`, or `saveSequential` for objects produced on demand). pdf.js reads Blobs of 16 MB or more by range (`openPdfJsDocument`). Thumbnails render only when on screen (`usePageThumbnails` + `VirtualGrid`).

`services/memoryManager.ts` owns object URLs (revoked after download), a canvas pool (canvases are zeroed on release), and pdf.js document destruction (`destroyPdfDocument`; pdf.js 6 has no `doc.destroy()`, it goes through the loading task).

## Subsystems

**Loading PDFs** — never call `PDFDocument.load` directly. Use `openPdf()` from `src/services/pdfLoader.ts`: it handles every Standard-security revision (RC4 40/128, AES-128, AES-256; `pdfSecurity.ts` + `legacyCrypto.ts` for MD5/RC4), decrypts encrypted object streams during parsing (by temporarily wrapping two pdf-lib parser methods), and loads with `updateMetadata: false`. Password-protected files are decrypted once at ingestion (`src/hooks/useFileIngestion.tsx` prompts, `unlock.worker.ts` decrypts), so tools receive plain PDFs.

**pdf.js assets** — CMaps, standard font data, WASM decoders (JPEG2000/JBIG2) and ICC profiles are copied to `public/pdfjs/` by `scripts/copy-pdfjs-assets.mjs` (runs on install/dev/build). Always open documents with `openPdfJsDocument()` from `src/services/pdfWorkerSetup.ts` so those URLs are passed.

**Edit engine** (`src/features/editPdf/engine/`):
- `lexer.ts` content-stream tokenizer with byte ranges (inline images included) and serializer
- `fontModel.ts` + `cmap.ts` + `encodingData.ts` — code splitting, widths (incl. standard-14 AFM metrics), Unicode (ToUnicode, encodings + Differences + glyph names), reverse encoding for reuse
- `interpreter.ts` — graphics/text state machine over page + form XObjects → glyphs (with op/element/byte provenance), text ops, images
- `layout.ts` — lines → paragraphs, hard vs soft line breaks, alignment, style
- `rewrite.ts` — glyph removal via TJ displacements, per-context rewriting (forms are cloned per use and renamed in the parent), mixed-font typesetting, new text/images/shapes, image move/delete
- `geometry.ts` — matrices and the viewer-space transform identical to pdf.js's `PageViewport` (all editor/overlay coordinates are "as displayed": rotation and CropBox applied)
- The editor UI (`EditPdfView.tsx`, `editor/*`) keeps a `DocEdits` document with undo/redo; the worker session renders a one-page preview PDF of every change.

**Shared services** — `fonts.ts` (standard fonts, or bundled fonts via fontkit for other text: Liberation Sans for Latin/Greek/Cyrillic, Noto Sans Devanagari, Noto Sans SC for Chinese/Japanese; `faceFor(text)` picks one. Devanagari is shaped per script run, and the shaped glyph positions are written as `TJ` adjustments. `patchSubsetter` works around a fontkit bug that dropped glyphs from Noto Sans SC subsets), `pageOverlay.ts` (draw in "as displayed" coordinates on rotated/cropped pages), `textLayout.ts` (structure recovery for PDF→Word/Markdown/Excel), `pageRanges.ts`, `imagePrep.ts`.

**UI** — design tokens in `src/index.css` / `tailwind.config.js`, primitives in `src/components/ui/`, every tool uses `ToolLayout` (workspace + options panel + run/result). Tool catalog metadata lives only in `src/constants/tools.ts`. Routing is hash-based (`#/merge`), tool views are lazy-loaded.

**pdf.js build** — the app imports `pdfjs-dist/legacy/build/pdf.mjs` and runs the legacy worker through `src/services/pdfjs.worker.ts`; the compressor uses `pdfjs-dist/legacy/image_decoders`. The legacy build bundles polyfills for recent JS APIs that pdf.js 6 uses: `Math.sumPrecise`, `Uint8Array.fromBase64`, and others. On engines without them, the modern build failed mid-render, and a failing `getDocument` could even make an encrypted file look unencrypted. `src/services/polyfills.ts` also installs `Map`/`WeakMap#getOrInsert(Computed)`. It is imported first by `main.tsx`, the pdf.js worker entry and `imageCodec.ts`. pdf.js is loaded on first use (dynamic `import()` in `useFileIngestion` / `usePdfRenderer`), which keeps the startup bundle at about 225 KB.

**Compression** (`src/features/compress/`):
- `imageCodec.ts` decodes any image XObject to RGBA:
  - DCT via pdf.js `JpegImage`, with `/Decode` and CMYK→RGB;
  - JPX via `JpxImage` (the WASM is at `pdfjs/wasm/`, configured with `configureJpx`);
  - Flate/LZW/RunLength/ASCII with PNG/TIFF predictors;
  - gray, RGB, CMYK, ICC, Cal, Lab-ish, Indexed and Separation color at 1/2/4/8/16 bpc.
- `compress.worker.ts` works out each image's displayed size from the page interpreter (`ImageInfo.ref` + `ctm`, so an image drawn small is downsampled more). It downsamples to the level's DPI and re-encodes photos as JPEG and flat art/masks as Flate. It keeps a result only if it is under 97% of the original, then removes duplicate streams and unreachable objects.
- Custom size runs a binary search over a 29-step dpi/quality ladder using a size estimate. It then steps down while the real saved file is still over target, and reports the setting it used.
- If nothing gets smaller, the original bytes are returned with an explanatory note.

**Repair** — `openPdf` failures are retried through `repair/salvage.ts`:
- an object pdf-lib can't parse is blanked out, keeping every other offset valid;
- a truncated trailing object is cut off, and a truncated Flate object stream is partially inflated and rewritten with only its complete objects;
- if the catalog/page tree was lost, surviving `/Page` objects are gathered under a new one.

**Saving results** — `ToolLayout` renders `components/common/AutoSave.tsx`, keyed per result buffer (`resultKey` in `services/fileNames.ts`):
- a 5 s countdown, then `onDownloadResult(fileName)`;
- the user can Save now, Rename, or turn off auto-save for that result, and afterwards save a copy under another name;
- `useToolRunner.download(name?)` honors the edited name;
- the editor shows the same component in a floating card after Export.

**Desktop** (`electron/main.cjs`, `electron/preload.cjs`):
- `dist/` is served from a privileged `app://ihatepdf/` scheme with explicit MIME types, so `fetch`, module workers and WASM work as on a web server; `file://` is no longer used.
- `show:false` + `ready-to-show`, a theme-matched `backgroundColor`, `v8CacheOptions: 'bypassHeatCheck'`, and no application menu.
- Single-instance lock.
- `will-prevent-unload` is ignored and `closed` → `app.quit()` on every platform, so the X button always ends the process.
- `will-download` saves to `Downloads/IHatePDF/` with ` (n)` de-duplication and sends `ihp:saved {name, path}`. The preload exposes `window.ihpDesktop.onSaved` / `showInFolder`, which the AutoSave component uses.
- The icon is at `build/icon.ico` (generated from `public/favicon.svg`). The packaged `app.asar` holds only `dist/` + `electron/`: `node_modules` is excluded, since everything is bundled by Vite.
- **Share to phone** (`src/features/share/ShareView.tsx`, desktop only). Files and folders go to a phone three ways:
  - *Same Wi-Fi* / *PC hotspot*: `share.cjs` serves a token-protected download page (QR code) for 1/5/10 min; folders and "everything" stream as stored (uncompressed) `.zip` from `zip.cjs`, ZIP64 past 4 GB. `hotspot.cjs` turns on Windows Mobile Hotspot through WinRT and shows a `WIFI:` join QR first, and turns it off afterwards if it turned it on.
  - *Bluetooth*: `bluetooth.cjs` scans (~8 s inquiry, phones only, nothing preselected) and sends with OBEX Object Push over an RFCOMM socket; several items go as one `.zip`. Android only, 4 GB max.
  - Hotspot and Bluetooth call Windows directly through `koffi` (FFI, in-process). No PowerShell or helper `.exe`: McAfee deleted a compiled helper, and PowerShell `Add-Type` (compiling C# at runtime) is a common antivirus trigger. WinRT method slots/IIDs come from `C:\Windows\System32\WinMetadata`.
  - The installer is per-machine (one UAC prompt) so `build/installer.nsh` can add a Windows Firewall rule (IHatePDF only, TCP, local subnet) and remove any block rule; without it Windows prompts on first share. `scripts/e2e/share.mjs` tests it all on 127.0.0.1 (`IHP_SHARE_HOST`), so it never triggers that prompt.
- CI: `.github/workflows/windows-installer.yml` builds `IHatePDF-Setup.exe` on `windows-latest` and uploads it as an artifact.

**Editor input** — pressing on an object captures the pointer on the page layer (for dragging), so the browser delivers `dblclick` to the layer, not the object. `PageCanvas` therefore also handles double-click on the layer and edits the current selection. Esc and Ctrl+Enter both finish an edit and keep the text.

**End-to-end tests** (`scripts/e2e/`, need `vite preview --port 4173`; render helpers also need `vite --port 5173`):
- `all-tools.mjs` drives all 28 tools plus auto-save in Chromium and validates every output;
- `compress.mjs` covers all levels plus custom sizes;
- `renderCompare.mjs` does a per-page pixel diff of two PDFs;
- `snapshot.mjs` renders page 1 of several PDFs side by side;
- `items.mjs` dumps text items;
- `electron.mjs` tests the desktop app (run under `xvfb-run` on Linux).

Large fixtures are generated into `test-fixtures/big/` (gitignored).

**Tests** — `npm test` runs the original conversion suite and `scripts/test-editor-and-tools.ts`, which generates a deliberately complicated PDF (`scripts/complexFixtures.ts`: kerned TJ, `'`/`"` operators, Tz/Ts/Tc/Tw, shared form XObject, inline image, rotated + cropped page, subset Type0 font, AcroForm, and RC4/AES-128 encrypted copies from an independent encryptor) and exercises the engine and tools against it.

## Commands

```bash
npm install                 # also copies pdf.js assets to public/pdfjs/
npm run dev                 # dev server
npm run build               # type-check + production build into dist/
npm run lint                # oxlint (warnings only)
npx tsx scripts/generateTestFixtures.ts && npm test      # 17 + 33 automated checks
npx tsx scripts/test-streaming-tools.ts <file.pdf>      # every streaming tool on a big file, with peak memory
node scripts/generateScanFixtures.mjs                    # realistic 300 dpi JPEG scans (10/50/150/500 MB) and journals in test-fixtures/scans/
npx vite preview --port 4173 & node scripts/e2e/all-tools.mjs   # all 28 tools in Chromium
node scripts/e2e/screenshots.mjs   # regenerate docs/screenshots (needs the preview server + big fixtures)
npm run build:exe           # FinalApp/IHatePDF-Setup.exe (Linux needs wine64 + wine32)
```

## Releases

`.github/workflows/windows-installer.yml` runs on `windows-latest` on every push to `main`, `claude/**` and `v*` tags:
1. `npm ci`;
2. lint;
3. tests;
4. `npm run build:exe`;
5. upload the installer as a workflow artifact.

On `main` (or a `v*` tag) it also publishes the GitHub Release `v<package.json version>` with `IHatePDF-Setup.exe` attached, using `docs/RELEASE_NOTES.md` as the body. Bump the version to cut a new release. The README's download button points to `releases/latest/download/IHatePDF-Setup.exe`.
Step-by-step: [docs/GITHUB_PUBLISH_GUIDE.md](docs/GITHUB_PUBLISH_GUIDE.md).
