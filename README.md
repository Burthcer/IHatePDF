# IHatePDF

**Every tool you need to work with PDFs — 100% client-side, zero server, zero uploads.**

![Architecture](https://img.shields.io/badge/architecture-100%25%20client--side-16A34A)
![Platform](https://img.shields.io/badge/platform-Windows-2563EB?logo=windows&logoColor=white)
![Stack](https://img.shields.io/badge/stack-React%20%2B%20Electron-61DAFB?logo=react&logoColor=black)
![AI](https://img.shields.io/badge/AI%20features-none-DC2626)
![License](https://img.shields.io/badge/license-MIT-green)

IHatePDF is a full PDF tool suite modeled on the iLovePDF catalog — merge, split, compress, convert, sign, redact, and more — with one hard rule: your files never leave your device. There is no backend, no upload endpoint, and no network call in the entire application. Every operation runs inside your own browser (or the bundled Electron shell) using WebAssembly and Web Workers.

There are deliberately no "AI" features — no summarizer, no AI translate, no cloud inference of any kind.

---

## Tool Matrix

| Category | Tools |
|---|---|
| **Edit** | **Edit PDF** — retype existing text like in a word processor (reflowed, in the document's own font where possible), move/resize/delete text and images, add text, images, shapes, highlights, whiteout · Sign · Fill forms · Watermark · Page numbers · Redact (draw or search) |
| **Organize** | Merge · Split (ranges, every N pages, one file per page) · Organize pages (reorder, rotate, duplicate, blank pages) · Rotate · Crop (drag edges, auto-detect margins) · Compare (word-level text diff + visual overlay) |
| **Convert from PDF** | Word (headings, lists, tables, bold/italic) · Excel (table detection, numeric cells) · PowerPoint (text removed from the background and rebuilt as editable text boxes) · JPG/PNG (up to 600 dpi) · Markdown |
| **Convert to PDF** | Images (any format the browser reads, EXIF-rotation aware) · Word · Excel · PowerPoint · HTML (laid out by the browser, drawn as real text) · Scan (camera with perspective correction and document clean-up) |
| **Optimize** | Compress — three presets (Light 220 dpi, Balanced 150 dpi, Smallest 96 dpi) or **Custom size**: type the size you need in MB or KB and it picks the best quality that fits (shrinks only, never upscales). Handles JPEG, JPEG 2000, CMYK, ICC, indexed, 16-bit and transparent images; merges duplicates and drops unused objects · Repair (recovers truncated/damaged files, including cut-off object streams) · PDF/A-2b |
| **Security** | Protect (AES-256) · Unlock (RC4 40/128, AES-128, AES-256) |

Every tool accepts password-protected and permission-restricted PDFs: owner-restricted files open transparently, and files with an open password prompt for it once when they're added.

### Auto-save

When a tool finishes (or you click Download in the editor), the result saves itself after a 5-second countdown under an automatic name such as `report_compressed.pdf`. During the countdown you can **Rename** it, **Save now**, or choose **Don’t save automatically**; afterwards you can save a copy under another name. In the desktop app files go straight to `Downloads\IHatePDF` (no Save dialog; an existing name gets ` (2)`, ` (3)`… appended) and **Show in folder** opens the location. In a browser they go to your normal downloads folder.

### How the text editor works

`src/features/editPdf/engine/` is a small PDF text engine: it parses each page's content streams (and form XObjects), tracks the graphics/text state like a renderer, maps every glyph to its Unicode text, font, color and exact position, and groups glyphs into lines and paragraphs. Editing a paragraph removes its glyphs from the content stream — each one becomes an equal `TJ` displacement, so nothing else moves — and typesets the new text in the original font when every character exists in it (subset fonts fall back per character), otherwise in the closest standard or bundled Unicode font. The preview you see while editing is pdf.js rendering the actual edited PDF.

Full technical details are in [`HANDOFF.md`](./HANDOFF.md).

---

## Security Model: Why Your Files Never Leave Your Device

IHatePDF has no backend. There is nothing to upload to, and nothing that could leak your documents even if it wanted to:

- **No network layer** — the app makes zero HTTP requests for document processing. Open your browser's Network tab during any operation and you'll see nothing but the initial page load.
- **RAM-only buffers** — files are read into `ArrayBuffer`s in memory and processed there. The only thing written to disk is the result you save (automatically after the countdown, or when you click Save).
- **Web Workers + WebAssembly** — every heavy operation (rendering, compression, encryption, format conversion) runs in an isolated Worker thread using `pdf-lib` and `pdfjs-dist`, not a remote service.
- **No accounts, no telemetry, no analytics** — there's nothing to sign in to and nothing phoning home.
- **Open source and verifiable** — don't take our word for it. Read the source, or just watch the Network tab yourself.

This isn't a policy promise ("we won't look at your files") — it's an architectural guarantee ("there is no server that could").

---

## Installation

### Windows Desktop App (recommended)

1. Get `IHatePDF-Setup.exe`: build it with `npm run build:exe` (it lands in `FinalApp/IHatePDF-Setup.exe`), or run the **Windows installer** workflow under the repository's Actions tab and download the `IHatePDF-Setup` artifact.
2. Run the installer. You'll get a normal setup wizard — choose your install location, and choose whether to create a desktop shortcut and Start Menu entry. Installing over an older version replaces it; your files are untouched. The installer isn't code-signed, so Windows SmartScreen may ask once: **More info → Run anyway**.
3. Launch IHatePDF from your Start Menu or desktop shortcut. No installation of Node, Python, or any runtime is required — everything is bundled.

The desktop app opens straight to the tool list (the window appears once the first frame is drawn, and compiled code is cached for later launches), runs as a single instance, and **quits completely when you close the window** — nothing stays in the background. Results are saved to `Downloads\IHatePDF`.

### Run it in any browser instead

IHatePDF is also a static web app — see [Local Development](#local-development) below to build and serve `dist/` yourself, no Electron required.

---

## Local Development

```bash
# Install dependencies
npm install

# Start the Vite dev server (hot-reload)
npm run dev

# Type-check and build production web assets to dist/
npm run build

# Package the Windows installer (IHatePDF-Setup.exe) into FinalApp/
npm run build:exe
 
# Generate test fixtures, then run the automated test suites (conversions + editor engine + tools)
npx tsx scripts/generateTestFixtures.ts
npm test

# Browser end-to-end tests of every tool (uses the built app on :4173 and
# the dev server on :5173 for page rendering)
npm run build && npx vite preview --port 4173 &
npx vite --port 5173 &
node scripts/e2e/all-tools.mjs            # all 28 tools + auto-save
node scripts/e2e/compress.mjs file.pdf    # every compression level + custom sizes
xvfb-run node scripts/e2e/electron.mjs    # desktop app: startup, auto-save folder, quit on close
```

**Stack:** React + TypeScript + Vite, Tailwind CSS, `pdf-lib` + `pdfjs-dist` for all PDF processing
(in Web Workers), pure OOXML parsers for PowerPoint (`pptxParser.ts`) and Word (`docxParser.ts`)
with direct `pdf-lib` vector rendering, `docx`/`pptxgenjs` for reverse conversions, Electron for
the desktop shell, `electron-builder` (NSIS target) for the Windows installer.

No PDF processing dependency ever makes a network call — everything ships bundled in the app.

## Testing

- `npm test` — `scripts/verify-conversions.ts` (17 conversion/tool checks) and `scripts/test-editor-and-tools.ts` (28 checks: the text-editing engine on a deliberately awkward PDF — kerned `TJ` text, form XObjects, rotated/cropped pages, subset Type0 fonts — plus encryption, layout analysis, and every tool on that file, including repairing a truncated copy).
- `scripts/e2e/all-tools.mjs` — drives the real built app in Chromium: every one of the 28 tools with dummy PDFs, Word/Excel/PowerPoint/HTML files and photos, checks each output, and checks the auto-save countdown and rename.
- `scripts/e2e/compress.mjs` / `renderCompare.mjs` — compression on large scanned and mixed-image PDFs (35–90 MB), custom target sizes, and a pixel comparison of original vs compressed pages.
- `scripts/e2e/electron.mjs` — the desktop app itself.

See [`TEST_REPORT.md`](docs/TEST_REPORT.md) for the latest results and [`RELEASE_NOTES.md`](docs/RELEASE_NOTES.md) for what changed.

---

## License & Contributions

See [`HANDOFF.md`](./HANDOFF.md) for architecture details, worker contracts, and the complete implementation status of every tool before contributing.
