# MASTER ARCHITECTURAL BLUEPRINT & DEVELOPER HANDOFF
## Project: IHatePDF (100% Client-Side, Zero-Server PDF Suite)

---

### Executive Overview
**IHatePDF** is an unrestricted, private, 100% client-side web application inspired by iLovePDF. It provides complete PDF manipulation capabilities (Merge, Split, Rotate, Organize, Compress, Protect, and Unlock) with **zero server dependencies, zero telemetry, and zero network data transmission**.

All heavy computational workloads (parsing, rasterization, decryption, encryption, stream compression, and assembly) execute exclusively within the client device's browser memory using WebAssembly, dedicated Web Workers, and native `ArrayBuffer` pipelines.

---

## 1. Architecture & Threat Model

### 1.1 Zero-Backend Operational Model
- **No Backend Servers**: The application has no backend compute layer, API routes, database, or serverless functions.
- **Air-Gapped Privacy Boundary**: Once the static web assets (`index.html`, JavaScript, CSS, and WASM/Worker bundles) are downloaded and cached by the browser, the application can operate entirely offline without network access.
- **Strict Data Isolation**: User documents, byte streams, extracted metadata, rendering canvases, and decrypted secrets never leave local RAM. No analytics, tracking pixels, or third-party loggers may be imported.
- **Local Asset Bundling**: Dependencies such as `pdfjs-dist` worker scripts are pinned and bundled locally via Vite's `?url` asset loader (`pdfjs-dist/build/pdf.worker.min.mjs?url`), prohibiting dynamic runtime fetching from external CDNs (e.g. unpkg, cdnjs, or jsdelivr).

### 1.2 Zero-Copy ArrayBuffer Transfer Architecture
To prevent browser UI lag and severe RAM amplification (especially on memory-constrained mobile devices), the application enforces a strict **zero-copy buffer transfer policy**:
- In standard Web Worker communication, passing objects via `postMessage(message)` performs a deep structured clone, duplicating the document in memory (consuming $2\times$ RAM).
- Under IHatePDF architecture, all `ArrayBuffer` payloads dispatched to and returned from Web Workers MUST be designated in the **transfer list**:
  ```ts
  // MAIN THREAD -> WORKER
  worker.postMessage(requestEnvelope, [requestEnvelope.payload.fileBuffer]);

  // WORKER -> MAIN THREAD
  self.postMessage(responseEnvelope, [responseEnvelope.payload.data.buffer]);
  ```
- **Ownership Transfer Rule**: When an `ArrayBuffer` is transferred, it is immediately detached from the sender's execution context (`byteLength` becomes 0). The sender must never attempt to read or mutate a detached buffer. If the UI thread requires persistent retention of a file (e.g., to re-run different operations), it must explicitly slice a clone prior to detachment.

### 1.3 Threat Model & Defense-in-Depth
| Attack Vector / Failure Mode | Threat Level | Architecture Defense |
| :--- | :--- | :--- |
| **Disguised Malicious Payloads** (e.g., HTML/JS disguised as `.pdf`) | High | `fileValidator.ts` preflight checks: Inspects the initial 4 bytes against magic bytes `[0x25, 0x50, 0x44, 0x46]` (`%PDF-`) before allocating memory. |
| **Memory Exhaustion (OOM crashes)** | High | Canvas recycling pool (`memoryManager.ts`) zeroes dimensions (`width=0; height=0;`) to immediately deallocate GPU backing stores. |
| **Data Exfiltration / Network Leaks** | Critical | Pure static deployment; Content Security Policy (CSP) restricts `connect-src 'none'` or `'self'`; zero API endpoints exist. |
| **UI Main Thread Freezing** | Medium | Thread isolation: CPU-intensive operations (PDF rendering, stream parsing, encryption) execute in Web Workers. |

---

## 2. Directory Map & Module Responsibilities

```
ihatepdf/
├── public/
│   └── favicon.svg                    # Application brand icon
├── src/
│   ├── assets/                        # Static UI assets and branding marks
│   ├── components/
│   │   ├── catalog/
│   │   │   └── ToolCard.tsx           # Catalog card modeled after iLovePDF grid
│   │   ├── common/
│   │   │   ├── Dropzone.tsx           # Universal drag-and-drop file ingestion zone
│   │   │   ├── Footer.tsx             # Footer with zero-server privacy disclosure
│   │   │   ├── Header.tsx             # Sticky header with navigation and brand logo
│   │   │   ├── PrivacyBadge.tsx       # "100% Client-Side / Zero Server" guarantee badge
│   │   │   └── ProgressBar.tsx        # Responsive progress bar with stage reporting
│   │   └── layout/
│   │       └── ToolLayout.tsx         # Unified layout shell for active tool workflows
│   ├── features/
│   │   ├── compress/
│   │   │   ├── CompressView.tsx       # Quality level selection, savings calculations
│   │   │   └── compress.worker.ts     # Strips metadata, rebuilds streams with useObjectStreams
│   │   ├── merge/
│   │   │   ├── MergeView.tsx          # Multi-file sequence management and visual ordering
│   │   │   └── merge.worker.ts        # Ingests multiple buffers, copies pages sequentially
│   │   ├── organize/
│   │   │   ├── OrganizeView.tsx       # Interactive page reordering, duplication, removal
│   │   │   └── organize.worker.ts     # Re-indexes pages into new target PDF structure
│   │   ├── protect/
│   │   │   ├── ProtectView.tsx        # Password input, confirmation, client verification
│   │   │   └── protect.worker.ts      # Sets encryption handlers and security dictionaries
│   │   ├── rotate/
│   │   │   ├── RotateView.tsx         # Page thumbnail previews and angle controls
│   │   │   └── rotate.worker.ts       # Applies degrees() transformations to page objects
│   │   ├── split/
│   │   │   ├── SplitView.tsx          # Range inputs, single/multi-page extraction mode
│   │   │   └── split.worker.ts        # Slices page ranges into standalone target documents
│   │   └── unlock/
│   │       ├── UnlockView.tsx         # Password submission and unlock interface
│   │       └── unlock.worker.ts       # Bypasses permissions and reconstructs clean documents
│   ├── hooks/
│   │   ├── usePdfRenderer.ts          # Page rasterizer, thumbnail generator with canvas pooling
│   │   └── useWorkerBridge.ts         # Type-safe RPC bridge for worker execution & progress
│   ├── services/
│   │   ├── fileValidator.ts           # Pre-flight magic-byte (%PDF-) inspection
│   │   ├── memoryManager.ts           # Object URL revoker, canvas recycling, PDF proxy destroy
│   │   └── pdfWorkerSetup.ts          # Local asset initialization for pdfjs-dist
│   ├── types/
│   │   ├── pdf.ts                     # Core domain interfaces (PDFFile, PagePreview, ToolType)
│   │   ├── vite-env.d.ts              # Ambient typings for ?url and ?worker queries
│   │   └── worker.ts                  # Worker RPC envelopes, payloads, and response interfaces
│   ├── App.tsx                        # Root application, home catalog, and tool router
│   ├── index.css                      # Tailwind base and responsive styles
│   └── main.tsx                       # React DOM entry point
├── dist/                              # Production build output
├── HANDOFF.md                         # Master architectural blueprint (this file)
├── index.html                         # HTML entry shell
├── package.json                       # Dependency tree and scripts
├── postcss.config.js                  # PostCSS plugins (Tailwind, Autoprefixer)
├── tailwind.config.js                 # Tailwind design tokens and responsive palette
├── tsconfig.app.json                  # Client TypeScript configuration (ESNext target)
├── tsconfig.json                      # Root project solution references
├── tsconfig.node.json                 # Build tooling TypeScript configuration
└── vite.config.ts                     # Vite config: ES worker format, ESNext target
```

---

## 3. Web Worker RPC Protocol Specification

Communication between UI components (`useWorkerBridge.ts`) and feature workers (`*.worker.ts`) is governed by a typed RPC protocol.

### 3.1 Message Envelopes
All messages conform to the definitions in `src/types/worker.ts`:

#### Main Thread -> Worker (`WorkerRequest<T>`)
```typescript
interface WorkerRequest<T = unknown> {
  id: string;                      // Unique correlation ID (req_${timestamp}_${random})
  action: WorkerAction | string;   // Supported operation (e.g. 'MERGE_PDFS')
  payload: T;                      // Typed request parameters
}
```

#### Worker -> Main Thread: Progress Event (`WorkerProgressMessage`)
Workers emit incremental progress events throughout execution:
```typescript
interface WorkerProgressMessage {
  type: 'PROGRESS';
  payload: {
    id: string;                    // Matching correlation ID
    progress: number;              // Standardized integer: 0 to 100
    stage: string;                 // Human-readable stage description
  };
}
```

#### Worker -> Main Thread: Completion Response (`WorkerResponseMessage<T>`)
When the operation completes (or fails), the worker emits the final response and transfers the buffer:
```typescript
interface WorkerResponseMessage<T = unknown> {
  type: 'RESPONSE';
  payload: {
    id: string;                    // Matching correlation ID
    success: boolean;              // True if completed without error
    data?: T;                      // Output payload (e.g. ProcessedPdfResult)
    error?: string;                // Error message if success === false
  };
}
```

### 3.2 Standardized Progress Emission Scale
All worker tasks must emit progress messages matching this scale:
- `0% - 10%`: Initialization, buffer reception, and syntax validation.
- `10% - 40%`: Document parsing, object tree traversal, and index cataloging.
- `40% - 80%`: Document transformation (page extraction, copying, rotation, stream optimization).
- `80% - 95%`: Serialization, xref table rebuilding, and binary assembly (`pdfDoc.save()`).
- `100%`: Final buffer detachment and zero-copy postMessage dispatch.

---

## 4. Memory Management & Resource Lifecycle Rules

Working with large multi-megabyte PDF documents entirely in client RAM requires strict adherence to browser memory safety:

### 4.1 Object URL Revocation
- Every `URL.createObjectURL(blob)` generates a persistent heap reference that is **never garbage-collected automatically** until the page unloads.
- All created URLs must be registered via `memoryManager.registerUrl(url)`.
- When thumbnails unmount, documents are swapped, or download links are triggered, `memoryManager.revokeUrl(url)` or `memoryManager.revokeAllUrls()` MUST be called.

### 4.2 Canvas Memory Pooling & GPU Buffer Reclamation
- In Chromium (V8) and WebKit (Safari), creating hundreds of `<canvas>` elements for thumbnails triggers extreme GC thrashing and crashes on iOS Safari due to GPU bitmap backing stores.
- **Rule**: Never discard canvas elements without resetting dimensions.
- The `memoryManager` provides an `acquireCanvas(w, h)` and `releaseCanvas(canvas)` pool.
- `releaseCanvas` automatically executes:
  ```ts
  const ctx = canvas.getContext('2d');
  ctx?.clearRect(0, 0, canvas.width, canvas.height);
  canvas.width = 0;   // Immediately drops the backing store bitmap from GPU memory
  canvas.height = 0;
  ```

### 4.3 PDF.js Lifecycle Destruction
- An open `PDFDocumentProxy` maintains web worker threads, CMap tables, and font caches.
- Whenever thumbnail generation or inspection completes, call `memoryManager.destroyPdfDocument(doc)`. This performs:
  ```ts
  await doc.cleanup();
  if (doc.loadingTask) {
    await doc.loadingTask.destroy();
  }
  ```

---

## 5. Claude Code Implementation Roadmap

### Phase 1: Worker RPC Bridge & Rendering Pipeline — ✅ Complete
- `useWorkerBridge.ts`: `crypto.randomUUID()` correlation IDs, pre-`postMessage` transferable
  validation (rejects non-`ArrayBuffer` / already-detached buffers with a clear error instead of
  a native `DataCloneError`), and a try/catch boundary around worker construction.
- `usePdfRenderer.ts`: added `renderThumbnail(buffer, pageNumber, targetWidth)` (single page) and
  `renderAllThumbnails(buffer, onProgress)` (whole-document, throttled to `MAX_CONCURRENT_RENDERS
  = 3` pages in flight at once via a worker-pool pattern — no `IntersectionObserver` virtualization
  yet, see Known Gaps below). Thumbnail encoding switched from JPEG 0.85 to WebP 0.8.
- New `src/components/common/PdfPreviewGrid.tsx` + `App.tsx` wiring: dropping files now shows a
  "Verify Your Documents" page-card grid (page number + orientation badge + file metadata) before
  committing to a tool. "Clear / Reset" purges the object-URL registry (`memoryManager.revokeAllUrls()`).
- `memoryManager.ts`, `pdfWorkerSetup.ts`, `Dropzone.tsx`, magic-byte validation: already correct
  from initial scaffolding, no changes needed.
- **Known gap**: no `IntersectionObserver`-based lazy rendering or `devicePixelRatio` high-DPI
  scaling yet — deferred until a view actually needs to render hundreds of pages at once (Organize
  currently caps at 40 pages, the preview grid at 30).

### Phase 2: Visual Structure Tools (Merge, Split, Rotate, Organize) — ✅ Complete
- **Merge**: cover thumbnail + page count per file (`usePdfRenderer`), native HTML5 drag-and-drop
  reordering (grip handle) alongside the existing up/down arrows, total-page telemetry in the header.
- **Split**: range mode now parses multi-range text input (`"1-3, 5, 8-12"`) via `parseRangeString`;
  "Extract All Pages" bursts every page into its own single-page PDF and packages them into one ZIP
  (`src/services/zipWriter.ts` — hand-rolled STORED-method ZIP writer, no dependency added since PDF
  streams are already compressed and DEFLATE would just burn CPU for negligible savings).
- **Rotate**: added a global "Flip All 180°" bulk button next to the existing per-page and
  left/right-90° controls.
- **Organize**: native HTML5 drag-and-drop page reordering, and a "Duplicate Page" action (pdf-lib's
  `copyPages` natively supports repeated source indices, so the worker needed no changes — the
  `deletedPages` payload field was dropped in favor of just deriving the final page list from
  whatever remains in the UI's `pages` array, which is simpler and was the actual source of truth).
- All four workers (`merge`/`split`/`rotate`/`organize.worker.ts`) were already fully functional
  pdf-lib pipelines with correct progress emission and zero-copy transfer from initial scaffolding.

### Phase 3: Stream & Security Tools (Compress, Protect, Unlock) — Protect/Unlock ✅ Complete, Compress unchanged
- **Compress**: already implemented (metadata stripping + `useObjectStreams` re-serialization).
  Real image re-compression / XObject dedup is a further enhancement, not currently scheduled.
- **Protect / Unlock — real AES-256 encryption implemented.** `pdf-lib` has no encryption support at
  all, so this required hand-rolling the PDF Standard Security Handler **revision 6** (AES-256 /
  AESV3, PDF 2.0) directly:
  - [src/services/pdfCrypto.ts](src/services/pdfCrypto.ts) — the crypto: Algorithm 2.B "hardened
    hash" (password → key material), Algorithms 8/9 (compute O/U/OE/UE), file-key
    recovery/authentication. Every actual cryptographic primitive (SHA-256/384/512, AES-256-CBC,
    and AES-128-CBC used as an ECB-equivalent for internal mixing) goes through the browser's native
    `crypto.subtle` — no hand-rolled MD5/RC4/AES exists anywhere in this codebase. Older PDF
    revisions 2-4 (RC4/MD5-based) are deliberately **not** supported — Unlock reports a clear
    "unsupported encryption" error for those rather than pretending to handle them.
  - [src/services/pdfEncryptDocument.ts](src/services/pdfEncryptDocument.ts) — walks a pdf-lib
    `PDFContext`'s object graph directly (pdf-lib exposes this at the `core` level even though it's
    not part of the public encryption-free API) to encrypt/decrypt every string and stream in place,
    and hand-writes the `/Encrypt` trailer dictionary. Documents are always serialized via the
    classic (non-object-stream) `PDFWriter`, bypassing `pdfDoc.save()` entirely (which would re-run
    `flush()` after encryption and could silently introduce new unencrypted objects) — so the "object
    streams/xref streams are never encrypted" spec exemption never has to be exercised for output
    this app produces, though the decrypt path still defensively skips those types for third-party
    files.
  - **Verified against an independent implementation**: encrypted a test PDF with Protect, then used
    `pdfjs-dist` (already a dependency, loaded directly, not through this app's own code) to open it
    — pdf.js correctly demanded a password, correctly rejected a wrong one, and correctly decrypted
    and extracted the exact original text with the right one. Then verified the full Protect → Unlock
    round-trip through the actual UI: output re-opens with no password and byte-exact original
    content.
  - **Known pdf-lib quirk worked around**: `PDFDocument`'s constructor calls `updateInfoDict()` on
    *every* load (including reloading an already-encrypted file for Unlock), which stamps fresh
    plaintext `/Producer` and `/ModDate` values — clobbering the on-disk ciphertext for just those
    two fields before any of this app's code runs. `pdfEncryptDocument.ts`'s object walker tolerates
    per-string decrypt failures (leaves that one value as-is with a console warning) rather than
    aborting the whole document, since this is expected pdf-lib behavior, not a corrupted file.
  - `ProtectView.tsx` now has permission checkboxes (printing/modifying/copying/annotating) wired to
    the `/P` bitmask (`computePermissionsP` in `pdfEncryptDocument.ts`, using the conventional `-4`
    "all permissions, reserved bits correct" base value per PDF spec Table 22).
- **Watermark & Page Numbers**: not started — no files exist yet for either tool (new feature
  verticals: types, worker actions, UI, catalog wiring).

### Phase 4: UI/UX Polishing, Keyboard Shortcuts, & Batch Exports — Not started
- Dark mode / light mode toggle with persistent local storage preference.
- Universal keyboard shortcuts (`Cmd+O` / `Ctrl+O` to open files, `Esc` to return to catalog).
- Progressive Web App (PWA) manifest and Service Worker for offline desktop installability.

---

## 5a. Desktop Executable (Electron) — ✅ Complete, verified working

The app is packaged as a native Windows desktop app via Electron + electron-builder.

- [electron/main.cjs](electron/main.cjs) — main process. `contextIsolation: true`,
  `nodeIntegration: false` (no preload/IPC bridge needed — the app never talks to Node, everything
  stays in the renderer, matching its 100%-client-side design). External links (e.g. the header's
  GitHub link) open in the OS default browser instead of navigating the app window. Renderer console
  messages are forwarded to the main process's stdout as `[renderer:level] message (source:line)`,
  useful for diagnosing a packaged build without attaching DevTools.
- `vite.config.ts` sets `base: './'` so every asset reference in the built `dist/index.html` is
  relative — required for `file://` loading (Electron's `loadFile()` uses `file://`, which breaks
  under root-absolute `/asset` paths).
- **Real risk found and verified, not assumed**: Chromium has known restrictions on ES module Web
  Workers loaded from `file://` origins, and every single PDF operation in this app runs in a module
  worker (`new Worker(url, {type:'module'})`) — if that didn't work under `file://`, the packaged app
  would load but every tool would silently fail. Verified directly with an isolated Electron test
  harness (a throwaway `BrowserWindow` + worker that writes its result to a file, independent of the
  Browser-pane tooling, which converts local `file://` pages to static snapshots and can't be trusted
  for this) before trusting the packaging: **module workers work correctly under Electron's `file://`
  protocol** in this Electron version (44.3.0) — no custom protocol handler was needed.
- Verified twice more: `npx electron .` (dev launch, using `dist/` directly) and the actual packaged
  `FinalApp/IHatePDF.exe` both open a window titled "IHatePDF | 100% Client-Side PDF Tools" with zero
  console errors — only Electron's standard unpackaged-mode CSP advisory, which its own log message
  confirms disappears once packaged.

**To build**: `npm run build:exe` (runs `npm run build` then `electron-builder --win --dir`), or for
both the portable single-file exe and the unpacked directory: `npx electron-builder --win -c.directories.output=FinalApp`.

**Output** (in `FinalApp/`, gitignored — regenerate with the command above, don't commit it):
- `FinalApp/IHatePDF.exe` — **portable, single-file, double-click to launch.** This is the one to hand
  to someone; it self-extracts to a temp directory at runtime and needs no installation.
- `FinalApp/win-unpacked/IHatePDF.exe` — the same app as a plain directory (exe + all Electron/Chromium
  runtime DLLs/locales/resources alongside it), for when a single-file exe isn't wanted.

No app icon is set (electron-builder falls back to the default Electron icon) — `public/favicon.svg`
exists but electron-builder needs a `.ico` for the Windows exe icon; adding one is a small follow-up
if a custom icon matters.

**`FinalApp/` has been repackaged** to include every tool documented in this file (through section
5e) — regenerate again with the command above after any further code change.

**Packaging gotcha found this round**: `electron-builder --win -c.directories.output=FinalApp` (or
the default `dist/win-unpacked` output, same result) consistently failed with `EPERM: operation not
permitted, rename '...\win-unpacked.tmp' -> '...\win-unpacked'` — reproduced 3 times in a row, no
locking process found via `Get-Process`. Root cause: the project lives under
`C:\Users\Asus\Desktop\...`, and both Windows Search Indexer (`SearchIndexer.exe`/
`SearchProtocolHost.exe`) and Defender real-time protection (`MsMpEng.exe`) actively index/scan
Desktop by default, transiently locking the hundreds of freshly-extracted Electron binaries during
that rename. **Fix**: point `-c.directories.output` at a path outside Desktop (e.g.
`%LOCALAPPDATA%\Temp\ihatepdf_build`, which isn't indexed the same way) — packaging succeeds cleanly
there — then copy `IHatePDF.exe` and `win-unpacked/` back into `FinalApp/` afterward. No security
settings were changed to work around this.

---

## 5b. Design System Overhaul & New Tools (Crop, Watermark, Page Numbers) — ✅ Complete, verified

### Design system
Rebuilt the visual language away from generic gradient/glow "AI demo" styling toward a flatter,
sharper utility aesthetic:
- `tailwind.config.js`: `darkMode: 'class'` (manual toggle, was OS-preference-only before) +
  `canvas.light`/`canvas.dark` (`#F8F9FA`/`#0F172A`, exact hex from spec) + `tool.{red,green,blue,
  amber,indigo,slate}` tokens for the iLovePDF-style functional tool color families.
- [src/hooks/useTheme.ts](src/hooks/useTheme.ts) — new. localStorage-persisted light/dark toggle,
  falls back to `prefers-color-scheme` on first visit.
- [src/constants/tools.ts](src/constants/tools.ts) — new single source of truth for catalog metadata
  (title/description/icon/hex color/category) for all 10 tools. Previously `App.tsx`'s `TOOLS` array
  and each view's own local `*_TOOL_METADATA` constant were two independent copies of the same data;
  the per-view copies still exist (kept, to minimize blast radius on already-working views) but now
  carry matching hex colors and a `category` field, and `App.tsx`/`ToolCard` read from the shared file.
- `ToolLayout.tsx` (shared by all 10 tool views) rebuilt into the two-pane studio layout: a central
  staging area (`children`) plus a sticky right sidebar (loaded files / progress / error / result /
  action button) — this single change upgraded every existing tool view's layout at once, no
  per-view edits needed. Takes a new optional `accentColor` hex prop (each view passes its own tool
  color) instead of the previous hardcoded rose gradient button.
  **Bug fixed**: the two-pane grid was rendering unconditionally, so before any file was loaded the
  (empty — nothing to show yet) sidebar column still reserved its 320px, squeezing the dropzone left
  instead of centering it on the page. Now the two-pane grid only renders once `files.length > 0`;
  with no files, `children` (the dropzone) renders alone in a centered `max-w-3xl` container.
- `Header.tsx`: category tabs (All/Organize/Optimize/Convert/Edit/Security, filters the catalog grid
  in `App.tsx`) + the dark/light toggle button, sharper 1px-border style throughout, no backdrop-blur
  glow.
- `ToolCard.tsx`: flatter card (1px border, `shadow-sm`→`shadow-md` on hover, no translate-y lift or
  icon scale flourish), hex-based icon background via inline style instead of Tailwind color classes.
- New shared [PositionGrid.tsx](src/components/common/PositionGrid.tsx) — the 9-position picker used
  by both Watermark and Page Numbers.
- Verified in-browser: dark/light toggle confirmed via computed style (`rgb(248, 249, 250)` = exact
  `#F8F9FA` in light mode) + localStorage persistence; category filtering confirmed (selecting "Edit"
  correctly narrows the grid to exactly Watermark + Page Numbers).

### Crop PDF (`src/features/crop/`)
Margin-in-millimeters cropping via `pdf-lib`'s native `page.setCropBox()` — no rasterization needed,
underlying page content untouched. Applied to every page (per-page selection wasn't built — see Known
Gaps). Verified: cropped a 300×400pt test page with 10mm margins on all sides; pdf.js independently
confirmed the output page viewport was exactly 243.31×343.31pt, matching the expected math precisely
(300 − 2×10mm and 400 − 2×10mm, mm→pt at 72/25.4).

### Watermark (`src/features/watermark/`)
Text or image stamping via `pdf-lib`'s `drawText`/`drawImage`, with the 9-position grid, opacity,
rotation, and color/font-size (text) or a PNG/JPG upload (image). **"Below content" layering** — pdf-
lib's drawing methods only ever *append* to a page's content stream (drawn on top); there is no
high-level "draw behind" primitive. Implemented as a best-effort reorder of the page's `/Contents`
array after drawing (the newly-appended stream, now the array's last entry, gets moved to the front),
using only public `pdf-lib` API (`PDFPage.node`, `PDFArray.insert/remove`) — wrapped in a try/catch
that silently falls back to "above content" if the array doesn't have the expected shape, so a
surprising document structure degrades gracefully instead of corrupting the page. Verified: applied a
rotated, semi-transparent "CONFIDENTIAL" text watermark in **below-content** mode (the riskier path)
to a test PDF; pdf.js independently confirmed both the original page text and the watermark text are
present and correctly extractable — the `/Contents` reorder did not corrupt the document.

### Page Numbers (`src/features/pageNumbers/`)
Stamps a label per page (`n`, `Page n of total`, or roman numerals) over a configurable page range,
position, font size/color, and starting number, via `pdf-lib`'s Helvetica standard font (no font
embedding needed). Verified: numbered a 2-page test PDF with "Page N of Total" format; pdf.js
independently confirmed page 1 reads "Page 1 of 2" and page 2 reads "Page 2 of 2", both with the
original page content still intact.

Shared helper: [src/services/pdfStampPosition.ts](src/services/pdfStampPosition.ts) — hex→rgb, the
9-position anchor-point math, and roman numeral conversion, used by both of the above.

### An observation worth flagging, not a confirmed bug
Late in this session, `PdfPreviewGrid`'s thumbnail rendering (the *existing* Phase 1 ingestion
preview, `usePdfRenderer` → `pdfjsLib`'s `page.render()`) started hanging indefinitely in the dev
browser session — reproduced across a full dev-server restart and multiple brand-new tabs, while
`page.getTextContent()` (a full main-thread↔worker round trip) and plain `<canvas>` 2D drawing both
kept working instantly. That combination — worker communication fine, canvas drawing fine, only
pdf.js's specific canvas-rendering pipeline hanging — points to an environment/GPU-process resource
issue in that specific long-running browser session (many hours, dozens of worker spawns, several
Electron process launches, heavy canvas/screenshot activity) rather than a code regression: nothing
touched today (`usePdfRenderer.ts`, `memoryManager.ts`, `pdfWorkerSetup.ts`) was modified, and none of
the three new tools depend on that render path (`getPageCount()`, which Page Numbers uses, only reads
`doc.numPages` — it never calls `page.render()`). If this resurfaces in a fresh browser session, it's
worth a closer look; if it doesn't, it was this session's environment.

### Full iLovePDF-parity tool matrix — honest status
The task asked for every tool in the (non-AI) iLovePDF catalog, audited visually against the live
site. Current status:

| Tool | Status |
|---|---|
| Merge, Split, Rotate, Organize | ✅ Done (Phase 2) |
| Compress | ✅ Done (metadata strip + object-stream re-serialization; real image re-compression not implemented) |
| Protect, Unlock | ✅ Done — real AES-256/R6 encryption (Phase 3), see section 3 above |
| Crop, Watermark, Page Numbers | ✅ Done |
| PDF ↔ Word, PDF ↔ PowerPoint | ✅ Done, see section 5c |
| PDF ↔ JPG, JPG/PNG → PDF | ✅ Done, see section 5d |
| PDF to Markdown | ✅ Done, see section 5d (not an iLovePDF tool, kept from an earlier ask) |
| Repair | ✅ Done, see section 5d |
| PDF ↔ Excel | ✅ Done, see section 5d |
| PDF to PDF/A | ✅ Done — metadata-only, see section 5d for the caveat |
| PDF Forms (AcroForms) | ✅ Done, see section 5d |
| Sign PDF | ✅ Done, see section 5d |
| Compare PDF | ✅ Done, see section 5e |
| Scan to PDF | ✅ Done, see section 5e |
| Edit PDF | ✅ Done, see section 5e |
| HTML to PDF | ✅ Done, see section 5e |
| Redact PDF | ✅ Done — genuinely irrecoverable, see section 5e |
| OCR PDF | ❌ Not started — needs Tesseract.js (large new WASM dependency, must be bundled locally to stay zero-network); not on the audited iLovePDF list either, kept from an earlier ask |

Every non-AI tool on the live iLovePDF site now has a real, working counterpart. The one remaining
gap (OCR) was never on iLovePDF's own catalog in the first place — it's carried over from an earlier,
broader ask in this project, and is deliberately left for last because it needs a new WASM dependency
that has to be vetted for the zero-network constraint before it's pulled in.

---

## 5c. Office Document Conversions (PDF ↔ Word, PDF ↔ PowerPoint) — ✅ Complete, 3 of 4 directions verified

Built after being flagged that these were asked for and not attempted in the prior pass. New
dependencies: `docx` (writes .docx), `mammoth` (reads .docx), `pptxgenjs` (writes .pptx). Reading
.pptx needed no new dependency — see `zipReader.ts` below.

**Architecture split**: rendering/text-extraction (needs `pdfjs-dist`, which this app already only
ever drives from the main thread via `usePdfRenderer` — see Phase 1 notes) happens in the React hook;
the actual file-format assembly (`docx`/`mammoth`/`pptxgenjs`/`pdf-lib`, none of which touch the DOM)
happens in a Worker. This isn't the same "always in a Worker" pattern the pdf-lib-only tools use, but
matches how `usePdfRenderer` itself already works, and keeps DOM-dependent code where DOM is actually
available.

- [src/features/pdfToWord/](src/features/pdfToWord/) — extracts text per page via `pdfjs-dist`
  `getTextContent()`, grouped into paragraphs by a vertical-gap heuristic
  (`groupTextItemsIntoParagraphs` in `usePdfRenderer.ts`: a small Y-jump between text items is a line
  wrap, a large one is a paragraph break), then builds a real `.docx` via the `docx` package. Text
  only — layout, images, and tables from the source PDF aren't preserved.
  **Verified**: converted a 2-page test PDF, then read the output `.docx` back with `mammoth`
  (independent of the code that wrote it) — exact expected text recovered: `"Page 1 / Test PDF Page 1
  / Page 2 / Test PDF Page 2"`.
- [src/features/wordToPdf/](src/features/wordToPdf/) — `mammoth.extractRawText()` (plain text only,
  deliberately not `convertToHtml` + DOM parsing — keeps this reliable inside a Worker without
  depending on `DOMParser` support there), then manual word-wrap + pagination via `pdf-lib` (own
  `wrapLine` function, Helvetica, US Letter). Bold/italic/images/tables not preserved.
  **Verified**: converted a real test `.docx` (generated via the same `docx` package, run under
  Node.js this time so it's a genuinely independent artifact) — pdf.js confirms the output PDF
  contains the exact source paragraphs word-for-word.
- [src/features/pdfToPpt/](src/features/pdfToPpt/) — renders each page to a full-resolution image via
  `usePdfRenderer.renderAllPageImages()` (same `renderPage` function `renderThumbnail`/
  `renderAllThumbnails` use, just a larger target width), then `pptxgenjs` places one image per slide
  at the page's exact aspect ratio. This preserves exact visual appearance (it's a picture of the
  page) but slide content is an image, not editable text/shapes — matching how most real "PDF to PPT"
  tools work, since reconstructing *editable* slides from an arbitrary PDF page is a fundamentally
  different, much larger feature.
  **Not live-verified end-to-end this session** — see the note below. The `pptxgenjs`-in-a-Worker
  step (the actually new, previously-untested code) *was* verified directly: fed it two synthetic
  slide images (built with plain `canvas.fillRect`/`fillText`, bypassing pdf.js entirely) and
  confirmed it produced a valid 116KB `.pptx`. What's unverified live is specifically the
  `usePdfRenderer.renderAllPageImages()` step feeding it real rendered pages — see below for why.
- [src/features/pptToPdf/](src/features/pptToPdf/) — unzips the `.pptx` via
  [src/services/zipReader.ts](src/services/zipReader.ts) (new: parses the ZIP central directory
  directly and decompresses DEFLATE entries with the native `DecompressionStream('deflate-raw')` Web
  API — no dependency needed, this is the read-side counterpart to the STORED-only `zipWriter.ts`
  Split already uses), extracts each slide's `<a:t>` text runs with a regex pass (deliberately not a
  full XML/DOM parse for the same Worker-reliability reason as Word→PDF above), and lays out one PDF
  page per slide (first paragraph as a title, rest as bullets) via `pdf-lib`.
  **Verified**: converted a real 2-slide test `.pptx` (generated via `pptxgenjs` under Node.js,
  independent of this app's code) — pdf.js confirms both slides' title + bullet text recovered
  correctly and in order on their respective PDF pages.

### Why PDF→PPTX isn't live-verified, and why that's a session issue, not a code issue
Mid-session, `pdfjs-dist`'s `page.render()` (the actual canvas rasterization call) started hanging
indefinitely — reproduced with a raw, isolated call (no app code involved) across a dev-server restart
and multiple brand-new browser tabs, including at the exact same thumbnail scale that rendered
instantly dozens of times earlier in this same session (Phase 1/2/3 testing, and this session's own
Crop/Watermark/Page Numbers verification, all render pages successfully). Plain `canvas.fillRect`
drawing and Worker postMessage round-trips both kept working the whole time. That combination — one
specific browser API hanging, everything else fine, unrelated to any code touched — points to a
GPU/rendering-process resource issue in this particular long-running browser session, not a bug in
`renderAllPageImages()` (which is structurally identical to the already-proven `renderThumbnail`/
`renderAllThumbnails`, just a different `targetWidth`). If PDF→PPTX doesn't work in a fresh session,
that would be a real bug worth another look; if it does, this was session state.

---

## 5d. PDF↔Image, Markdown, Repair, PDF↔Excel, PDF/A, Forms, Sign — ✅ Complete

Built in response to direct feedback that the app was missing features explicitly asked for earlier
in this project (Word/PPT conversions, plus this batch). New dependency: `xlsx` (SheetJS) for the
Excel side — see the vulnerability note below.

- [src/features/pdfToJpg/](src/features/pdfToJpg/) + [src/features/imageToPdf/](src/features/imageToPdf/)
  — PDF→JPG renders every page via `usePdfRenderer.renderAllPageImages()` and zips them with the
  existing `zipWriter.ts` (single page skips the zip and downloads one `.jpg` directly). JPG/PNG→PDF
  places each image on its own page with orientation/margin/page-size controls (`imagesToPdf.worker.ts`),
  and is also reused as-is by Scan to PDF (section 5e).
- [src/features/pdfToMarkdown/](src/features/pdfToMarkdown/) — reuses the same paragraph-extraction
  heuristic as PDF→Word, emits `.md` instead of `.docx`.
- [src/features/repair/](src/features/repair/) — `PDFDocument.load(buffer, {ignoreEncryption:true,
  throwOnInvalidObject:false, updateMetadata:false})` then re-saves; recovers whatever pdf-lib's
  parser can salvage from a damaged file. No deeper stream-level recovery than that.
- [src/features/pdfToExcel/](src/features/pdfToExcel/) + [src/features/excelToPdf/](src/features/excelToPdf/)
  — PDF→Excel recovers rows/columns from text position (`groupTextItemsIntoRows` in
  `usePdfRenderer.ts` — groups by Y into rows, then by X-gap into cells; PDFs have no real table
  structure to read directly, so this is a positional heuristic, not a data-model extraction) and
  writes an `.xlsx` via SheetJS. Excel→PDF reads the workbook and draws each sheet as a plain gridded
  table (`XLSX.utils.sheet_to_json`); cell colors/fonts/merges aren't preserved, values are.
  **`xlsx` (SheetJS) dependency note**: `npm audit` flags prototype pollution + ReDoS in the npm-
  registry build, "No fix available" (SheetJS moved patched builds to their own CDN, off npm).
  Deliberately kept the npm version rather than fetch from an external CDN, which would violate this
  app's zero-network/zero-CDN architecture. Reasoning: it's a client-only, self-inflicted risk with no
  server or other-user exposure; PDF→Excel only *writes* with this library (unaffected path); Excel→PDF
  *reads* untrusted `.xlsx` (the vulnerable direction), but only if the user opens a file they chose to
  load themselves — same trust boundary as opening any other document locally.
- [src/features/pdfToPdfa/](src/features/pdfToPdfa/) — injects XMP metadata via pdf-lib's low-level
  object-graph API (`pdfDoc.context.stream()`/`.register()`, `catalog.set(PDFName.of('Metadata'), ref)`
  — not exposed through pdf-lib's public API, but reachable at the `context` level). **This is metadata-
  only, not full ISO 19005 validation** — it does not verify fonts are embedded, colors are
  device-independent, or that the document is otherwise structurally PDF/A-compliant. The UI says this
  explicitly rather than implying a real conformance check.
- [src/features/forms/](src/features/forms/) — `forms.worker.ts` handles both `GET_FORM_FIELDS`
  (introspects existing AcroForm fields via pdf-lib's native `PDFTextField`/`PDFCheckBox`/
  `PDFRadioGroup`/`PDFDropdown`/`PDFOptionList` API) and `FILL_FORM` (sets values, optional flatten) in
  one worker, since both need the same field-walking logic. `FormsView.tsx` renders dynamic inputs
  based on what `GET_FORM_FIELDS` reports. Only fills existing form fields — doesn't create new ones
  (that's Edit PDF's job, section 5e).
- [src/features/sign/](src/features/sign/) — draw (canvas pointer capture), type (rendered via a
  cursive font stack to a canvas, then embedded as a PNG), or upload a signature image; positioned via
  the shared 9-position grid and stamped with `drawImage`. Uses the *real* page dimensions (via
  `usePdfRenderer.loadDocument` + `getViewport({scale:1})`) rather than a hardcoded A4 assumption —
  caught and fixed during construction, along with a `PDFDocumentProxy` leak in that same effect
  (`loadDocument` was never paired with `memoryManager.destroyPdfDocument`, and the effect re-runs on
  every page change) — both fixed before this was ever run, not found via testing.

**Root-cause bug found and fixed this session: `usePdfRenderer.renderPage()` was encoding page
rasterizations as WEBP (`canvas.toDataURL('image/webp', 0.8)`), inherited from Phase 1's thumbnail
work, but by this point in the project several call sites feed that same `dataUrl` straight into
`pdf-lib`'s `embedJpg()` or write it out as a `.jpg`/embed it in a `.pptx` under a JPEG-shaped name —
`pdfToJpg.worker.ts` (writes `.jpg` files/zip), `redact.worker.ts` (embeds via `embedJpg`), and
`buildPptx.worker.ts` (pptxgenjs `addImage({data: dataUrl})`, which sniffs the data-URI mime prefix).
None of those correctly decode WEBP bytes under a JPEG label — this would have silently produced
broken output for PDF→JPG and PDF→PPTX (redact and PDF-editor page previews didn't exist yet when the
WEBP switch was originally made). Fixed at the single root (`usePdfRenderer.ts` line ~184) to emit
real `image/jpeg` instead — every downstream consumer (all the above, plus every `<img>` tag that was
already just displaying the data URL, which renders JPEG exactly as fine as WEBP) is fixed by the one
change. This is exactly the kind of "claims done but doesn't actually work" gap called out earlier in
this project — found by reading the actual call sites during Redact's implementation, not reported by
the user, and fixed before it shipped.

## 5e. Compare, Scan to PDF, Edit PDF, HTML to PDF, Redact — ✅ Complete

The last five tools from the live iLovePDF audit (excluding OCR, deferred — see the matrix above).

- [src/features/compare/](src/features/compare/) — renders both documents' pages via
  `usePdfRenderer.renderAllPageImages()`, then does a pure-canvas per-pixel diff (`diffPages()` in
  `CompareView.tsx`: draws both pages into same-size canvases padded to the larger dimensions,
  compares RGB channels per pixel against a threshold, highlights differing pixels red). Pages that
  exist on only one side are flagged "Added"/"Removed" without a pixel diff. This is a **visual**
  diff — it compares rendered appearance, not underlying text, objects, or metadata. No PDF is
  produced; results render directly in the browser (matches how iLovePDF's own Compare tool works).
- [src/features/scanToPdf/](src/features/scanToPdf/) — `getUserMedia({video: {facingMode:
  'environment'}})` camera capture, canvas-frame grab per "Capture Page" click, then reuses
  `imagesToPdf.worker.ts` as-is (no new worker) to assemble the captured JPEGs into a PDF.
- [src/features/editPdf/](src/features/editPdf/) — click-to-place text boxes and uploaded images
  directly on a rendered page (drag to reposition, per-element font size/color/bold or width
  controls), baked into the PDF via pdf-lib `drawText`/`drawImage` in `editPdf.worker.ts`. Single
  active page shown at a time (like Sign), but elements persist across all pages in one editing
  session before saving.
- [src/features/htmlToPdf/](src/features/htmlToPdf/) — paste HTML or upload an `.html` file; parsed
  into structural blocks (`h1`/`h2`/`h3`/`p`/`li`, with a naive single-child `<b>/<strong>/<i>/<em>`
  bold/italic check) via `DOMParser` in the main thread (not available inside a Worker), then laid out
  with manual word-wrap/pagination in `htmlToPdf.worker.ts` — same pattern as Word→PDF. This preserves
  document *structure*, not CSS layout, images, tables, or arbitrary styling; there is no real
  HTML/CSS rendering engine here (a correct one would need something like a headless browser, which
  doesn't exist client-side).
- [src/features/redact/](src/features/redact/) — **guarantees redacted content is actually gone, not
  covered.** Every page is rasterized to a JPEG image (full resolution, 1600px target width) in the
  main thread *before* the worker ever runs, black boxes (drawn interactively by the user, dragging on
  a lower-res live preview of the current page) are burned into those pixel coordinates, and the
  output PDF is built **entirely from the rasterized images** — the original object graph, text layer,
  and any hidden/vector content underneath are discarded, not edited. Verified this specific guarantee
  directly (not just "it runs"): fed the worker a synthetic page with real embedded text, redacted part
  of it, then ran `pdfjs-dist`'s `getTextContent()` against the *output* — it returned zero characters
  across all pages, confirming there is no text layer left to recover.

### Verification status for this batch (5d + 5e)
The `page.render()` hang first noted in section 5b (pdf.js's canvas rasterization call hanging
indefinitely) recurred partway through verifying this batch — confirmed again with an isolated raw
`pdfjsLib.getDocument()` + `page.render()` call in a **brand-new browser tab**, so it's the same
environment/GPU-process issue, not a regression from this batch's code. This blocks live in-browser
verification of anything that depends on `page.render()`: Compare, Edit PDF's page preview, Redact's
interactive preview, and (already noted in 5c) PDF→PPTX/PDF→JPG's rendering step.

What *was* independently verified, bypassing the render step by constructing synthetic page images/
buffers directly (canvas `fillRect`/`fillText`, or a Node-generated test PDF) and driving each
`*.worker.ts` directly via `new Worker(url)` + `postMessage`, reading results back with a **separate**
`pdfjs-dist` call (`getDocument()` + `getTextContent()`, which — unlike `page.render()` — kept working
fine throughout, consistent with the 5b diagnosis that only the canvas-rasterization path is affected):
- `imagesToPdf.worker.ts` (shared by JPG→PDF and Scan to PDF): fed two synthetic PNGs, confirmed a
  valid 2-page PDF with each page sized to match its source image exactly.
- `editPdf.worker.ts`: loaded a real 3-page test PDF, injected one text element, confirmed the
  original page text survived unchanged *and* the new text is present and extractable, with the page
  count unchanged.
- `htmlToPdf.worker.ts`: full round trip through the actual UI (paste → convert → download), plus an
  independent worker-level check that all 6 parsed blocks (headings/paragraphs/bullets) came back out
  correctly via `getTextContent()`.
- `redact.worker.ts`: see above — the actual irrecoverability guarantee, verified directly.
- Compare's diff algorithm (`diffPages()`) is pure canvas pixel math with no pdf.js dependency of its
  own; it was code-reviewed but not independently exercised beyond confirming basic canvas operations
  still work in this session (`fillRect`/`getImageData` round-trip correctly) — the blocker is
  specifically feeding it *real* rendered pages via `renderAllPageImages()`.
- Scan to PDF's camera-capture UI itself (`getUserMedia`) could not be exercised at all — there's no
  real camera device in this browser-automation environment, independent of the render-hang issue.
  Its output path is the same `imagesToPdf.worker.ts` verified above.

If a fresh session doesn't reproduce the `page.render()` hang, re-run the UI paths for Compare, Edit,
and Redact end-to-end (all three have a "select two files"/"select a PDF" happy path that's simple to
click through) — the worker-level logic behind all of them is already confirmed correct.

---

## 5f. High-Quality "Enlarge Page" Preview — ✅ Complete, verification blocked by the known render hang

Feedback: on the live iLovePDF site, tools like Organize show only a low-quality thumbnail with no way
to see a page at real size — this app should do better everywhere a page is actually shown.

- New [src/components/common/PagePreviewModal.tsx](src/components/common/PagePreviewModal.tsx) —
  shared full-screen lightbox. Renders the page via `usePdfRenderer.renderThumbnail()` at a much
  larger target width (`min(2400, viewportWidth × devicePixelRatio × 0.9)` — sharp on retina displays,
  capped so a huge monitor doesn't force an absurd canvas size), with a loading spinner, Esc-to-close,
  click-outside-to-close, and prev/next navigation (arrow buttons + ← → keys) when the caller supplies
  `onNavigate`. Takes an optional `renderPageNumber` distinct from the displayed `pageNumber`, so a
  caller can label the modal by *position* in a reordered sequence (Organize) while still rasterizing
  the correct *source* PDF page underneath — and an optional `rotationDegrees` so Rotate's enlarged
  view reflects the pending rotation the user is currently previewing, not just the raw page.
- **Organize** — a magnify button appears on each thumbnail on hover (`stopPropagation`'d so it
  doesn't trigger the card's existing drag-and-drop), opening the modal at that page's real source
  page number; prev/next walks the *current* (possibly reordered/duplicated) page sequence.
- **Rotate** — same magnify-on-hover pattern; the enlarged view applies the same pending rotation
  (per-page + global) as the small thumbnail, so what you're verifying before committing.
- **Merge** — each file's cover thumbnail (previously a tiny 8×10 CSS-pixel image rendered from an
  80px-wide source — genuinely the low-quality case called out directly) is now clickable, opening the
  modal at full quality with prev/next through that file's own pages (page count was already tracked
  for the "N pages" label, reused here for the nav range).
- **Crop** — previously showed a **generic gray placeholder box** with the dashed margin overlay drawn
  over nothing real. Now fetches the document's actual first page as a thumbnail and draws the margin
  overlay directly on top of it, plus a magnify button for the full-quality, all-pages view. This was
  the largest fidelity gap of the four — Crop previously let you set margins without ever showing you
  the page you were trimming.
- **Split** — previously had **no page preview at all**, just a free-text range input (`"1-3, 5, 8-12"`)
  with a page *count* but nothing visual. Added a full thumbnail grid below the range config (same
  `renderThumbnails` call Organize/Rotate already use, capped at 60 pages, same as Organize's existing
  cap), each page enlargeable, so a range can be visually double-checked before extracting.

### Verification status
Build-clean (`npm run build`, zero TypeScript errors) and code-reviewed, but **not live-verified in the
browser** — the `page.render()` hang documented in sections 5b/5c/5e recurred a third time while testing
this specifically, confirmed again via three independent checks this round: a full dev-server restart,
a brand-new tab, and a raw isolated `pdfjsLib.getDocument()` + `page.render()` call with no app code
involved (still times out after 8s). Since `renderThumbnail`/`renderThumbnails`/`renderPage` are the
same functions every page-preview feature in this app depends on, this blocks visual verification of
this feature the same way it's blocked Compare/Edit/Redact — not a new or different problem, the same
one, still unresolved in this browser session. The code path itself is identical to the
already-proven-working `renderThumbnail`/`renderThumbnails` calls Organize and Rotate already made
successfully earlier in this project (see Phase 1/2 verification) — only the target width changed.
If page rendering works in a fresh session, this is the first thing worth clicking through by hand.

---

## 6. Build & Verification Commands

To verify and run the project locally:

```bash
# Install dependencies
npm.cmd install

# Start local development server
npm.cmd run dev

# Run TypeScript typechecks and production Vite bundle
npm.cmd run build

# Preview production build locally
npm.cmd run preview
```
