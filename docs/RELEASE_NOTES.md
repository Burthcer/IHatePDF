# IHatePDF v1.1.0

A reliability release: every tool was re-tested end to end on real files, and everything that didn't work was fixed.

## Install

1. Download **IHatePDF-Setup.exe** below, under *Assets*.
2. Run it. If Windows says *"Windows protected your PC"*, click **More info → Run anyway**. The installer isn't code-signed.
3. Follow the setup, then open IHatePDF from the desktop or Start menu. It replaces any older version, and your files are untouched.

## New

- **Custom compression size.** Choose *Custom size*, type a target in MB or KB (it can only shrink, never grow), and the compressor finds the best image resolution and quality that fits, e.g. 35.5 MB → 1.95 MB for a 2 MB target.
- **Auto-save.** Finished results save themselves after a 5-second countdown under an automatic name. During the countdown you can rename the file, save it right away, or turn auto-save off for that result. You can also save a copy under another name later. The editor's Download button uses the same flow.
- **Desktop app saves to `Downloads\IHatePDF`** with no dialog. Existing names get a ` (2)` suffix, and **Show in folder** opens the location.
- **Word-processor-style PDF editing.** Double-click any text to retype it. The paragraph reflows in the document's own font, and the old characters are removed from the file, not just covered. You can also move and resize text and images, and add text, images, shapes, highlights and whiteout.
- **Redesigned interface** across the home screen and every tool.

## Fixed

- **Compress now actually compresses.** Before, it only recompressed plain RGB/gray JPEGs, so most real PDFs came back unchanged apart from the name. It now decodes and re-encodes:
  - JPEG, JPEG 2000, CMYK, ICC-based, indexed, 16-bit, soft-masked and predictor-compressed images;
  - downsampled to the chosen DPI at their *displayed* size.

  It also merges duplicate images and drops unused objects. A 35.5 MB scan goes to 1.7 MB (Balanced), and an 88.6 MB mixed file to 3.1 MB, with no visible change.
- **Double-click to edit text** in the editor didn't open the text box: the drag handler captured the pointer and swallowed the double-click. Pressing Esc while typing now keeps your text.
- **Page rendering and password detection** broke on Chromium/Electron builds without the newest JavaScript APIs (`Math.sumPrecise`, `Map#getOrInsertComputed`). This could also make a password-protected file look unprotected. The app now uses pdf.js's legacy build, which includes polyfills.
- **Repair** recovers truncated downloads: a cut-off compressed object stream is partially recovered, unreadable objects are skipped, and a lost page tree is rebuilt.
- **HTML to PDF** could convert the previous HTML if you clicked *Create PDF* right after pasting or opening a file.
- **PDF to Markdown / Excel / Word:**
  - tables drawn with padding spaces are detected;
  - two side-by-side text columns are no longer mistaken for a table;
  - superscripts stay on their line.
- **Desktop app:**
  - closing the window always quits (nothing is left running in the background);
  - only one copy runs at a time;
  - the window appears once the first frame is drawn, with no blank white window;
  - compiled code is cached, so later launches are faster;
  - pdf.js is loaded on first use, so the startup bundle is 225 KB instead of 712 KB;
  - the app is served over an `app://` protocol, so WASM decoders and workers behave exactly as on the web;
  - the installer has a proper icon and no longer bundles unused `node_modules`.

## Testing

`npm test` (45 checks) plus browser end-to-end runs of all 28 tools, the compression levels on 35–90 MB files, and the Electron app. See the [test report](https://github.com/Burthcer/IHatePDF/blob/main/docs/TEST_REPORT.md).
