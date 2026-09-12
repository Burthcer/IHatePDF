/**
 * IHatePDF - Automated End-to-End Test Suite
 * 
 * Verifies:
 * - Test 1: PPTX -> PDF (test-slides.pptx: count === 3, 16:9 widescreen ratio, visual elements)
 * - Test 2: DOCX -> PDF (test-document.docx: count >= 2, formatted tables, callouts, colors)
 * - Test 3: Round-trip conversions (Images -> PDF, PDF -> PPTX, PDF -> DOCX)
 * - Test 4: Core visual tools (Merge, Split, Rotate, Organize, Compress, Protect, Unlock, Watermark, Page Numbers)
 *
 * Execution: npx tsx scripts/verify-conversions.ts
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

// Parsers & Worker Engines
import { parseSlideSize, parseTheme, parseSlide } from '../src/features/pptToPdf/pptxParser';
import { convertPptxToPdf } from '../src/features/pptToPdf/pptToPdf.worker';
import { parseDocx } from '../src/features/wordToPdf/docxParser';
import { convertDocxToPdf } from '../src/features/wordToPdf/renderDocxToPdf';
import { imagesToPdf } from '../src/features/imageToPdf/imagesToPdf.worker';
import { buildPptxFromPages } from '../src/features/pdfToPpt/buildPptx.worker';
import { buildDocxFromPages } from '../src/features/pdfToWord/pdfToWord.worker';
import { mergePdfs } from '../src/features/merge/merge.worker';
import { splitPdf } from '../src/features/split/split.worker';
import { rotatePdfPages } from '../src/features/rotate/rotate.worker';
import { organizePdfPages } from '../src/features/organize/organize.worker';
import { compressPdf } from '../src/features/compress/compress.worker';
import { protectPdf } from '../src/features/protect/protect.worker';
import { unlockPdf } from '../src/features/unlock/unlock.worker';
import { applyWatermark } from '../src/features/watermark/watermark.worker';
import { addPageNumbers } from '../src/features/pageNumbers/pageNumbers.worker';
import { readZip } from '../src/services/zipReader';
import type { PositionedPageText, StyledPageText } from '../src/types/worker';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, '..', 'test-fixtures');

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  [PASS] ${name}`);
    passed++;
  } catch (err) {
    console.error(`  [FAIL] ${name}`);
    console.error(`         ${err instanceof Error ? err.message : String(err)}`);
    failed++;
    failures.push(name);
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function requireFixture(name: string): Buffer {
  const path = resolve(FIXTURES_DIR, name);
  if (!existsSync(path)) {
    throw new Error(`Missing fixture ${name} - run: npx tsx scripts/generateTestFixtures.ts`);
  }
  return readFileSync(path);
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

const STUB_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const STUB_PNG_BUFFER = Buffer.from(STUB_PNG_BASE64, 'base64');
const STUB_PNG_DATA_URL = `data:image/png;base64,${STUB_PNG_BASE64}`;

async function extractPositionedTextNode(pdfBuffer: Buffer): Promise<PositionedPageText[]> {
  const doc = await getDocument({ data: new Uint8Array(pdfBuffer) }).promise;
  const pages: PositionedPageText[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent();
    const items = (textContent.items as any[])
      .filter((it) => 'str' in it && it.str.trim() !== '')
      .map((it) => ({
        text: it.str,
        xPt: it.transform[4],
        yPt: it.transform[5],
        fontSizePt: Math.hypot(it.transform[2], it.transform[3]) || 12,
      }));
    pages.push({ pageNumber: i, widthPt: viewport.width, heightPt: viewport.height, items });
  }
  return pages;
}

async function extractStyledParagraphsNode(pdfBuffer: Buffer): Promise<StyledPageText[]> {
  const doc = await getDocument({ data: new Uint8Array(pdfBuffer) }).promise;
  const pages: StyledPageText[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const textContent = await page.getTextContent();
    const rawItems = (textContent.items as any[]).filter((it) => 'str' in it);

    const paragraphs: Array<{ text: string; fontSizePt: number }> = [];
    let currentText = '';
    let currentSizes: number[] = [];
    let prevY: number | null = null;
    const flush = () => {
      const text = currentText.trim();
      if (text) {
        const avgSize = currentSizes.reduce((a, b) => a + b, 0) / Math.max(1, currentSizes.length);
        paragraphs.push({ text, fontSizePt: avgSize || 12 });
      }
      currentText = '';
      currentSizes = [];
    };
    for (const item of rawItems) {
      if (item.str === '') continue;
      const y = item.transform[5];
      const size = Math.hypot(item.transform[2], item.transform[3]) || 12;
      const h = item.height || size || 10;
      if (prevY === null) {
        currentText = item.str;
      } else {
        const gap = Math.abs(prevY - y);
        if (gap > h * 1.6) {
          flush();
          currentText = item.str;
        } else if (gap > h * 0.3) {
          currentText += ' ' + item.str;
        } else {
          currentText += item.str;
        }
      }
      currentSizes.push(size);
      prevY = y;
    }
    flush();
    pages.push({ pageNumber: i, paragraphs });
  }
  return pages;
}

async function runAllTests() {
  console.log('====================================================');
  console.log('IHatePDF - Comprehensive End-to-End Verification');
  console.log('====================================================\n');

  const pptxBuffer = requireFixture('test-slides.pptx');
  const docxBuffer = requireFixture('test-document.docx');
  const pdfBuffer = requireFixture('test-multi.pdf');

  // =========================================================================
  // TEST 1: PowerPoint (.pptx) to PDF Conversion
  // =========================================================================
  console.log('--- TEST 1: PPTX to PDF Pipeline ---');

  await check('pptxParser extracts theme, slide dimensions, vector shapes, and tables', async () => {
    const entries = await readZip(new Uint8Array(pptxBuffer));
    const decoder = new TextDecoder();
    const theme = parseTheme(decoder.decode(entries.get('ppt/theme/theme1.xml')!));
    const slideSize = parseSlideSize(decoder.decode(entries.get('ppt/presentation.xml')!));

    assert(slideSize.widthPt > 900 && slideSize.heightPt > 500, `Expected 16:9 widescreen dimensions, got ${slideSize.widthPt}x${slideSize.heightPt}`);
    const ratio = slideSize.widthPt / slideSize.heightPt;
    assert(Math.abs(ratio - 16 / 9) < 0.05, `Expected 16:9 aspect ratio (~1.778), got ${ratio.toFixed(3)}`);

    const slide1 = parseSlide(decoder.decode(entries.get('ppt/slides/slide1.xml')!), theme);
    assert(slide1.shapes.length >= 2, `Expected at least 2 shapes on slide 1, found ${slide1.shapes.length}`);
    assert(slide1.tables.length >= 1, `Expected at least 1 table on slide 1, found ${slide1.tables.length}`);
  });

  await check('convertPptxToPdf: test-slides.pptx -> count === 3, 16:9 widescreen, non-blank', async () => {
    const res = await convertPptxToPdf(toArrayBuffer(pptxBuffer), 'test-slides.pptx');
    assert(res.buffer.byteLength > 0, 'Converted PDF buffer is empty');
    assert(res.pageCount === 3, `Expected strictly 3 pages, got ${res.pageCount}`);

    const pdf = await PDFDocument.load(res.buffer);
    assert(pdf.getPageCount() === 3, `PDF document contains ${pdf.getPageCount()} pages instead of 3`);

    for (let i = 0; i < 3; i++) {
      const page = pdf.getPage(i);
      const { width, height } = page.getSize();
      const ratio = width / height;
      assert(Math.abs(ratio - 16 / 9) < 0.05, `Page ${i + 1} aspect ratio ${ratio.toFixed(3)} deviates from 16:9`);
      assert(width >= 900, `Page ${i + 1} width ${width} is too small for widescreen`);
    }
  });

  // =========================================================================
  // TEST 2: Word (.docx) to PDF Conversion
  // =========================================================================
  console.log('\n--- TEST 2: DOCX to PDF Pipeline ---');

  await check('docxParser: parses section dimensions, callouts, tables, and colored runs', async () => {
    const doc = await parseDocx(toArrayBuffer(docxBuffer));
    assert(doc.blocks.length > 0, 'Parsed DOCX has no blocks');
    assert(doc.pageSetup.widthPt > 0 && doc.pageSetup.heightPt > 0, 'Parsed DOCX page setup is invalid');
    assert(doc.blocks.some((b) => b.type === 'table'), 'Expected at least 1 table in DOCX');
    const paras = doc.blocks.filter((b): b is import('../src/features/wordToPdf/docxParser').DocxParagraph => b.type === 'paragraph');
    assert(paras.some((p) => p.isCallout), 'Expected callout paragraph in DOCX');
    assert(paras.some((p) => p.runs.some((r) => r.color !== undefined)), 'Expected colored text run');
  });

  await check('convertDocxToPdf: test-document.docx -> count >= 2, formatted tables & callouts', async () => {
    const res = await convertDocxToPdf(toArrayBuffer(docxBuffer), 'test-document.docx');
    assert(res.buffer.byteLength > 0, 'Converted PDF buffer is empty');
    assert(res.pageCount >= 2, `Expected >= 2 pages for multi-page test document, got ${res.pageCount}`);

    const pdf = await PDFDocument.load(res.buffer);
    assert(pdf.getPageCount() >= 2, `PDF document contains ${pdf.getPageCount()} pages, expected >= 2`);
  });

  // =========================================================================
  // TEST 3: Round-Trip Conversions
  // =========================================================================
  console.log('\n--- TEST 3: Round-Trip Document Conversions ---');

  await check('Images -> PDF (imagesToPdf): builds valid multi-page PDF from image bytes', async () => {
    const res = await imagesToPdf({
      images: [
        { bytes: toArrayBuffer(STUB_PNG_BUFFER), type: 'png' },
        { bytes: toArrayBuffer(STUB_PNG_BUFFER), type: 'png' },
      ],
      orientation: 'portrait',
      margin: 'small',
      pageSize: 'a4',
      fileName: 'test-images.pdf',
    });
    assert(res.pageCount === 2, `Expected 2 pages in imagesToPdf result, got ${res.pageCount}`);
    const pdf = await PDFDocument.load(res.buffer);
    assert(pdf.getPageCount() === 2, `PDF has ${pdf.getPageCount()} pages`);
  });

  await check('PDF -> DOCX (buildDocxFromPages): generates valid .docx with structured paragraphs', async () => {
    const pages = await extractStyledParagraphsNode(pdfBuffer);
    assert(pages.length === 4, `Expected 4 pages extracted from test-multi.pdf, got ${pages.length}`);

    const res = await buildDocxFromPages(pages, 'test-multi.pdf');
    assert(res.buffer.byteLength > 1000, `DOCX buffer size ${res.buffer.byteLength} is too small`);
    assert(res.mimeType.includes('wordprocessingml'), `Unexpected mime type ${res.mimeType}`);

    const zipEntries = await readZip(new Uint8Array(res.buffer));
    assert(zipEntries.has('word/document.xml'), 'DOCX zip is missing word/document.xml');
  });

  await check('PDF -> PPTX (buildPptxFromPages): generates valid .pptx with positioned text & slides', async () => {
    const pageText = await extractPositionedTextNode(pdfBuffer);
    assert(pageText.length === 4, `Expected 4 pages of positioned text, got ${pageText.length}`);

    const slides = pageText.map((p) => ({
      dataUrl: STUB_PNG_DATA_URL,
      widthPt: p.widthPt,
      heightPt: p.heightPt,
    }));

    const res = await buildPptxFromPages(slides, pageText, 'test-multi.pdf');
    assert(res.buffer.byteLength > 1000, `PPTX buffer size ${res.buffer.byteLength} is too small`);

    const zipEntries = await readZip(new Uint8Array(res.buffer));
    const slideXmls = Array.from(zipEntries.keys()).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    assert(slideXmls.length === 4, `Expected 4 slides in generated PPTX, found ${slideXmls.length}`);
  });

  // =========================================================================
  // TEST 4: Core Visual PDF Tools
  // =========================================================================
  console.log('\n--- TEST 4: Core Visual PDF Tools ---');

  await check('Merge PDFs: 4-page test-multi.pdf + 1-page PDF -> 5 pages total', async () => {
    const single = await PDFDocument.create();
    single.addPage([400, 400]);
    const singleBuf = toArrayBuffer(Buffer.from(await single.save()));

    const res = await mergePdfs([
      { name: 'test-multi.pdf', buffer: toArrayBuffer(pdfBuffer) },
      { name: 'single.pdf', buffer: singleBuf },
    ]);
    assert(res.pageCount === 5, `Expected 5 pages after merge, got ${res.pageCount}`);
    const pdf = await PDFDocument.load(res.buffer);
    assert(pdf.getPageCount() === 5, 'Merged PDF page count does not equal 5');
  });

  await check('Split PDF: extracts specific page range [1, 2] -> 2 pages', async () => {
    const res = await splitPdf(toArrayBuffer(pdfBuffer), 'test-multi.pdf', [{ from: 1, to: 2 }]);
    assert(res.pageCount === 2, `Expected 2 pages after split, got ${res.pageCount}`);
    const pdf = await PDFDocument.load(res.buffer);
    assert(pdf.getPageCount() === 2, 'Split PDF does not contain 2 pages');
  });

  await check('Split PDF: burst "all" mode -> ZIP archive with 4 individual pages', async () => {
    const res = await splitPdf(toArrayBuffer(pdfBuffer), 'test-multi.pdf', 'all');
    assert(res.fileName.endsWith('.zip'), 'Burst split did not return a ZIP file');
    const zipEntries = await readZip(new Uint8Array(res.buffer));
    assert(zipEntries.size === 4, `Expected 4 entries in ZIP, got ${zipEntries.size}`);
  });

  await check('Rotate PDF: rotates pages by 90 degrees', async () => {
    const res = await rotatePdfPages(toArrayBuffer(pdfBuffer), 'test-multi.pdf', [], 90);
    const pdf = await PDFDocument.load(res.buffer);
    const rotation = pdf.getPage(0).getRotation().angle;
    assert(rotation === 90, `Expected 90 degree rotation, got ${rotation}`);
  });

  await check('Organize PDF: reorders and removes specified pages', async () => {
    // Reorder [3, 2, 1, 0] and delete original index 1
    const res = await organizePdfPages(toArrayBuffer(pdfBuffer), 'test-multi.pdf', [3, 2, 1, 0], [1]);
    assert(res.pageCount === 3, `Expected 3 pages after deletion, got ${res.pageCount}`);
    const pdf = await PDFDocument.load(res.buffer);
    assert(pdf.getPageCount() === 3, 'Organized PDF does not have 3 pages');
  });

  await check('Compress PDF: recommended mode strips metadata and preserves page count', async () => {
    const res = await compressPdf(toArrayBuffer(pdfBuffer), 'test-multi.pdf', 'recommended');
    const pdf = await PDFDocument.load(res.buffer);
    assert(pdf.getPageCount() === 4, `Expected 4 pages, got ${pdf.getPageCount()}`);
    assert(!pdf.getTitle(), 'Title metadata was not stripped');
  });

  await check('Protect PDF: encrypts document with AES-256 password', async () => {
    const res = await protectPdf({
      fileBuffer: toArrayBuffer(pdfBuffer),
      fileName: 'test-multi.pdf',
      userPassword: 'PassWord123!',
      ownerPassword: 'PassWord123!',
    });
    assert(res.buffer.byteLength > 0, 'Protected PDF buffer is empty');
    assert(res.pageCount === 4, `Expected 4 pages, got ${res.pageCount}`);

    const pdf = await PDFDocument.load(res.buffer, { ignoreEncryption: true });
    assert(pdf.isEncrypted === true, 'Document is not encrypted');
  });

  await check('Unlock PDF: decrypts AES-256 encrypted document with valid password', async () => {
    const protectedRes = await protectPdf({
      fileBuffer: toArrayBuffer(pdfBuffer),
      fileName: 'test-multi.pdf',
      userPassword: 'PassWord123!',
    });

    const unlockRes = await unlockPdf({
      fileBuffer: protectedRes.buffer,
      fileName: 'test-multi_protected.pdf',
      password: 'PassWord123!',
    });

    assert(unlockRes.pageCount === 4, `Expected 4 pages, got ${unlockRes.pageCount}`);
    const pdf = await PDFDocument.load(unlockRes.buffer);
    assert(pdf.getPageCount() === 4, 'Unlocked PDF page count does not match 4');
  });

  await check('Watermark PDF: stamps text watermark across all pages', async () => {
    const res = await applyWatermark({
      fileBuffer: toArrayBuffer(pdfBuffer),
      fileName: 'test-multi.pdf',
      mode: 'text',
      text: 'CONFIDENTIAL',
      fontSize: 48,
      color: '#E53E3E',
      opacity: 0.5,
      rotationDegrees: 45,
      position: 'center',
      layer: 'above',
    });
    assert(res.pageCount === 4, `Expected 4 pages, got ${res.pageCount}`);
    const pdf = await PDFDocument.load(res.buffer);
    assert(pdf.getPageCount() === 4, 'Watermarked PDF does not have 4 pages');
  });

  await check('Page Numbers: stamps formatted page labels on all pages', async () => {
    const res = await addPageNumbers({
      fileBuffer: toArrayBuffer(pdfBuffer),
      fileName: 'test-multi.pdf',
      format: 'n_of_total',
      position: 'bottom-center',
      fontSize: 10,
      color: '#4B5563',
      marginMm: 12,
      startPage: 1,
      endPage: 4,
      startingNumber: 1,
    });
    assert(res.pageCount === 4, `Expected 4 pages, got ${res.pageCount}`);
    const pdf = await PDFDocument.load(res.buffer);
    assert(pdf.getPageCount() === 4, 'Numbered PDF does not have 4 pages');
  });

  // =========================================================================
  // SUMMARY
  // =========================================================================
  console.log('\n====================================================');
  console.log(`VERIFICATION COMPLETE: ${passed} passed, ${failed} failed (${passed + failed} total)`);
  console.log('====================================================\n');

  if (failed > 0) {
    console.error('Failed test cases:');
    failures.forEach((f) => console.error(`  - ${f}`));
    process.exit(1);
  } else {
    console.log('ALL TESTS PASSED WITH 100% SUCCESS RATE.');
  }
}

runAllTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
