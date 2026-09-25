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
| **Optimize** | Compress (image recompression, duplicate/unused object removal) · Repair · PDF/A-2b |
| **Security** | Protect (AES-256) · Unlock (RC4 40/128, AES-128, AES-256) |

Every tool accepts password-protected and permission-restricted PDFs: owner-restricted files open transparently, and files with an open password prompt for it once when they're added.

### How the text editor works

`src/features/editPdf/engine/` is a small PDF text engine: it parses each page's content streams (and form XObjects), tracks the graphics/text state like a renderer, maps every glyph to its Unicode text, font, color and exact position, and groups glyphs into lines and paragraphs. Editing a paragraph removes its glyphs from the content stream — each one becomes an equal `TJ` displacement, so nothing else moves — and typesets the new text in the original font when every character exists in it (subset fonts fall back per character), otherwise in the closest standard or bundled Unicode font. The preview you see while editing is pdf.js rendering the actual edited PDF.

Full technical details are in [`HANDOFF.md`](./HANDOFF.md).

---

## Security Model: Why Your Files Never Leave Your Device

IHatePDF has no backend. There is nothing to upload to, and nothing that could leak your documents even if it wanted to:

- **No network layer** — the app makes zero HTTP requests for document processing. Open your browser's Network tab during any operation and you'll see nothing but the initial page load.
- **RAM-only buffers** — files are read into `ArrayBuffer`s in memory and processed there. Nothing is written to disk unless you explicitly click Download.
- **Web Workers + WebAssembly** — every heavy operation (rendering, compression, encryption, format conversion) runs in an isolated Worker thread using `pdf-lib` and `pdfjs-dist`, not a remote service.
- **No accounts, no telemetry, no analytics** — there's nothing to sign in to and nothing phoning home.
- **Open source and verifiable** — don't take our word for it. Read the source, or just watch the Network tab yourself.

This isn't a policy promise ("we won't look at your files") — it's an architectural guarantee ("there is no server that could").

---

## Installation

### Windows Desktop App (recommended)

1. Download `IHatePDF-Setup.exe` from the [Releases](../../releases) page.
2. Run the installer. You'll get a normal setup wizard — choose your install location, and choose whether to create a desktop shortcut and Start Menu entry.
3. Launch IHatePDF from your Start Menu or desktop shortcut. No installation of Node, Python, or any runtime is required — everything is bundled.

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
 
# Generate test fixtures, then run the comprehensive automated test suite
npm test
# or: npx tsx scripts/verify-conversions.ts
```

**Stack:** React + TypeScript + Vite, Tailwind CSS, `pdf-lib` + `pdfjs-dist` for all PDF processing
(in Web Workers), pure OOXML parsers for PowerPoint (`pptxParser.ts`) and Word (`docxParser.ts`)
with direct `pdf-lib` vector rendering, `docx`/`pptxgenjs` for reverse conversions, Electron for
the desktop shell, `electron-builder` (NSIS target) for the Windows installer.

No PDF processing dependency ever makes a network call — everything ships bundled in the app.

## Testing

`scripts/verify-conversions.ts` executes the end-to-end automated test suite (17/17 tests passing,
100% success rate) against real generated fixtures (`test-slides.pptx`, `test-document.docx`, `test-multi.pdf`)
covering PowerPoint to PDF, Word to PDF, round-trip conversions (Images, Word, PowerPoint), and all
core PDF tools (Merge, Split, Rotate, Organize, Compress, Protect, Unlock, Watermark, Page Numbers).
See [`TEST_REPORT.md`](docs/TEST_REPORT.md) for full execution results and logs. See [`RELEASE_NOTES.md`](docs/RELEASE_NOTES.md) for release notes.

---

## License & Contributions

See [`HANDOFF.md`](./HANDOFF.md) for architecture details, worker contracts, and the complete implementation status of every tool before contributing.
