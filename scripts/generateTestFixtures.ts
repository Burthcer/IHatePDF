/**
 * Test fixture generator — IHatePDF
 *
 * Builds real, styled, non-trivial documents used to verify the high-
 * fidelity conversion pipelines (see scripts/verify-conversions.ts). These
 * are genuine .pptx/.docx/.pdf files (not stubs) — a 3-slide widescreen presentation
 * with dark theme, colored table, gradient, vector shapes, and callouts;
 * a 2-page docx with title blocks, custom callout styling, colored text spans,
 * and a styled border table; and a 4-page PDF mixing portrait/landscape.
 *
 * Run: npx tsx scripts/generateTestFixtures.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pptxgen from 'pptxgenjs';
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  AlignmentType,
  BorderStyle,
  PageBreak,
} from 'docx';
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import { readZip } from '../src/services/zipReader';
import { createZip } from '../src/services/zipWriter';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'test-fixtures');
mkdirSync(OUT_DIR, { recursive: true });

async function buildPresentation(): Promise<void> {
  const pres = new pptxgen();
  // Standard 16:9 Widescreen (10 x 5.625 in or 13.33 x 7.5 in)
  pres.defineLayout({ name: 'WIDE_16_9', width: 13.33, height: 7.5 });
  pres.layout = 'WIDE_16_9';

  // --- Slide 1: Dark theme, colored header, bullet points, colored 2x2 data table, vector shapes ---
  const s1 = pres.addSlide();
  s1.background = { color: '111827' }; // Dark slate background
  s1.addText('Executive Quarterly Performance', {
    x: 0.8,
    y: 0.5,
    w: 11.5,
    h: 0.9,
    fontSize: 32,
    bold: true,
    color: 'E11D48', // Crimson accent
    fontFace: 'Arial',
  });
  s1.addText(
    [
      { text: 'Enterprise client adoption surged 38% QoQ', options: { bullet: true, breakLine: true } },
      { text: 'Average document processing throughput reached 12k ops/sec', options: { bullet: true, breakLine: true } },
      { text: 'Zero-server architecture eliminated 100% of data transit risk', options: { bullet: true } },
    ],
    { x: 0.8, y: 1.6, w: 6.2, h: 2.2, fontSize: 16, color: 'F1F5F9', fontFace: 'Arial' }
  );

  // Vector rectangle accent shape
  s1.addShape(pres.ShapeType.rect, {
    x: 9.5,
    y: 1.6,
    w: 2.8,
    h: 1.6,
    fill: { color: 'F59E0B' }, // Amber fill
    line: { color: 'B45309', width: 2 },
  });
  s1.addText('HIGH PRIORITY\nMETRIC TARGET', {
    x: 9.5,
    y: 1.6,
    w: 2.8,
    h: 1.6,
    fontSize: 14,
    bold: true,
    color: '78350F',
    align: 'center',
    valign: 'middle',
  });

  // Colored 2x2 Data Table (with header row + 2 data rows)
  s1.addTable(
    [
      [
        { text: 'Market Territory', options: { fill: { color: '374151' }, color: 'FFFFFF', bold: true } },
        { text: 'Net Expansion', options: { fill: { color: '374151' }, color: 'FFFFFF', bold: true } },
      ],
      [
        { text: 'North America (US/CA)', options: { fill: { color: '1F2937' }, color: 'F1F5F9' } },
        { text: '+42.5%', options: { fill: { color: '1F2937' }, color: '34D399', bold: true } },
      ],
      [
        { text: 'Asia-Pacific (APAC)', options: { fill: { color: '111827' }, color: 'F1F5F9' } },
        { text: '+58.1%', options: { fill: { color: '111827' }, color: '34D399', bold: true } },
      ],
    ],
    { x: 0.8, y: 4.2, w: 7.5, h: 2.2, fontSize: 13, border: { color: '4B5563', pt: 1 } }
  );

  // --- Slide 2: Gradient background, two-column layout with styled text boxes, ellipse shape ---
  const s2 = pres.addSlide();
  s2.addText('Two-Column Architecture & Infrastructure', {
    x: 0.8,
    y: 0.5,
    w: 11.5,
    h: 0.8,
    fontSize: 26,
    bold: true,
    color: 'FFFFFF',
  });
  s2.addText(
    'Column A: Thread-isolated WebAssembly processing engines run inside dedicated Web Workers off the main thread. All operations use zero-copy ArrayBuffer transfer lists.',
    { x: 0.8, y: 1.6, w: 5.5, h: 4.5, fontSize: 15, color: 'FFFFFF', fontFace: 'Arial' }
  );
  s2.addText(
    'Column B: Memory manager maintains an active Object URL registry with canvas dimension zeroing to completely eliminate GPU backing store memory leaks and Safari crashes.',
    { x: 7.0, y: 1.6, w: 5.5, h: 4.5, fontSize: 15, color: 'FFFFFF', fontFace: 'Arial' }
  );
  // Ellipse shape
  s2.addShape(pres.ShapeType.ellipse, {
    x: 9.8,
    y: 4.8,
    w: 2.4,
    h: 1.6,
    fill: { color: '10B981' },
    line: { color: '059669', width: 2 },
  });

  // --- Slide 3: Light theme, rounded rectangle callout, vector lines, and summary table ---
  const s3 = pres.addSlide();
  s3.background = { color: 'F8FAFC' }; // Clean light slate
  s3.addText('System Verification & Security Review', {
    x: 0.8,
    y: 0.5,
    w: 11.5,
    h: 0.8,
    fontSize: 26,
    bold: true,
    color: '0F172A',
  });
  s3.addShape(pres.ShapeType.roundRect, {
    x: 0.8,
    y: 1.5,
    w: 11.5,
    h: 1.8,
    fill: { color: 'EFF6FF' },
    line: { color: '3B82F6', width: 2 },
  });
  s3.addText('AIR-GAPPED THREAT MODEL: Zero network requests are permitted. All document buffers are securely transformed in browser RAM and immediately revoked upon task completion.', {
    x: 1.1,
    y: 1.7,
    w: 10.9,
    h: 1.4,
    fontSize: 15,
    bold: true,
    color: '1E40AF',
  });
  s3.addText('Summary of Verified Modules:', {
    x: 0.8,
    y: 3.6,
    w: 11.5,
    h: 0.5,
    fontSize: 18,
    bold: true,
    color: '334155',
  });
  s3.addTable(
    [
      [
        { text: 'Module', options: { fill: { color: 'E2E8F0' }, bold: true, color: '0F172A' } },
        { text: 'Thread Isolation', options: { fill: { color: 'E2E8F0' }, bold: true, color: '0F172A' } },
        { text: 'Fidelity Status', options: { fill: { color: 'E2E8F0' }, bold: true, color: '0F172A' } },
      ],
      [
        { text: 'PPTX Engine', options: { fill: { color: 'FFFFFF' }, color: '334155' } },
        { text: 'Worker Thread (ESM)', options: { fill: { color: 'FFFFFF' }, color: '059669' } },
        { text: '1-to-1 Parity', options: { fill: { color: 'FFFFFF' }, color: '059669', bold: true } },
      ],
      [
        { text: 'DOCX Engine', options: { fill: { color: 'F8FAFC' }, color: '334155' } },
        { text: 'Worker Thread (ESM)', options: { fill: { color: 'F8FAFC' }, color: '059669' } },
        { text: '1-to-1 Parity', options: { fill: { color: 'F8FAFC' }, color: '059669', bold: true } },
      ],
    ],
    { x: 0.8, y: 4.3, w: 11.5, h: 2.2, fontSize: 13, border: { color: 'CBD5E1', pt: 1 } }
  );

  const buffer = (await pres.write({ outputType: 'nodebuffer' })) as Buffer;

  // Patch slide2's background to a real linear gradient fill
  const entries = await readZip(new Uint8Array(buffer));
  const slide2Name = 'ppt/slides/slide2.xml';
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const slide2Data = entries.get(slide2Name);
  if (slide2Data) {
    let slide2Xml = decoder.decode(slide2Data);
    const gradientBg =
      '<p:bg><p:bgPr>' +
      '<a:gradFill><a:gsLst>' +
      '<a:gs pos="0"><a:srgbClr val="7C3AED"/></a:gs>' +
      '<a:gs pos="100000"><a:srgbClr val="DB2777"/></a:gs>' +
      '</a:gsLst></a:gradFill>' +
      '<a:effectLst/></p:bgPr></p:bg>';

    if (!slide2Xml.includes('<p:bg>')) {
      slide2Xml = slide2Xml.replace('<p:spTree>', `${gradientBg}<p:spTree>`);
    }
    entries.set(slide2Name, encoder.encode(slide2Xml));
  }

  const zipEntries = Array.from(entries.entries()).map(([name, data]) => ({ name, data }));
  const finalBuffer = createZip(zipEntries);

  writeFileSync(resolve(OUT_DIR, 'test-slides.pptx'), finalBuffer);
  writeFileSync(resolve(OUT_DIR, 'sample-presentation.pptx'), finalBuffer);
  console.log('  wrote test-slides.pptx (3 slides, 16:9 widescreen)');
}

async function buildDocument(): Promise<void> {
  const tableBorder = {
    style: BorderStyle.SINGLE,
    size: 1,
    color: '64748B',
  };

  const doc = new Document({
    styles: {
      paragraphStyles: [
        {
          id: 'Callout',
          name: 'Callout',
          basedOn: 'Normal',
          next: 'Normal',
          run: { color: '7F1D1D', bold: true },
          paragraph: { spacing: { before: 200, after: 200 } },
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: 1440,
              right: 1440,
              bottom: 1440,
              left: 1440,
            },
          },
        },
        children: [
          // --- PAGE 1: Title Block, Colored Callout, Direct Colored Text, Invoice Table ---
          new Paragraph({
            heading: HeadingLevel.TITLE,
            children: [
              new TextRun({
                text: 'Invoice #4471 - Professional Services',
                color: '0F172A',
                bold: true,
                size: 36,
              }),
            ],
          }),
          new Paragraph({
            heading: HeadingLevel.HEADING_2,
            children: [
              new TextRun({
                text: 'Client: Acme Global Logistics Ltd.',
                color: 'E11D48',
                size: 24,
              }),
            ],
          }),
          new Paragraph({
            style: 'Callout',
            children: [
              new TextRun({
                text: 'URGENT CALLOUT: Payment is due within 14 calendar days. Late payments accrue 1.5% monthly compound interest.',
                color: '991B1B',
                bold: true,
              }),
            ],
          }),
          new Paragraph({
            spacing: { before: 140, after: 140 },
            children: [
              new TextRun({ text: 'This statement covers verified services rendered in ' }),
              new TextRun({ text: 'March 2026', bold: true, color: '0284C7' }),
              new TextRun({ text: ', including ' }),
              new TextRun({ text: 'expedited freight handling', italics: true, color: '059669' }),
              new TextRun({ text: ' across two international shipments.' }),
            ],
          }),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              new TableRow({
                children: [
                  new TableCell({
                    shading: { fill: '1E293B' },
                    borders: { top: tableBorder, bottom: tableBorder, left: tableBorder, right: tableBorder },
                    children: [new Paragraph({ children: [new TextRun({ text: 'Service Item', bold: true, color: 'FFFFFF' })] })],
                  }),
                  new TableCell({
                    shading: { fill: '1E293B' },
                    borders: { top: tableBorder, bottom: tableBorder, left: tableBorder, right: tableBorder },
                    children: [new Paragraph({ children: [new TextRun({ text: 'Units', bold: true, color: 'FFFFFF' })] })],
                  }),
                  new TableCell({
                    shading: { fill: '1E293B' },
                    borders: { top: tableBorder, bottom: tableBorder, left: tableBorder, right: tableBorder },
                    children: [new Paragraph({ children: [new TextRun({ text: 'Subtotal Amount', bold: true, color: 'FFFFFF' })] })],
                  }),
                ],
              }),
              new TableRow({
                children: [
                  new TableCell({
                    shading: { fill: 'F8FAFC' },
                    borders: { top: tableBorder, bottom: tableBorder, left: tableBorder, right: tableBorder },
                    children: [new Paragraph({ children: [new TextRun({ text: 'Expedited Freight Logistics', color: '1E293B' })] })],
                  }),
                  new TableCell({
                    shading: { fill: 'F8FAFC' },
                    borders: { top: tableBorder, bottom: tableBorder, left: tableBorder, right: tableBorder },
                    children: [new Paragraph({ children: [new TextRun({ text: '2 shipments', color: '1E293B' })] })],
                  }),
                  new TableCell({
                    shading: { fill: 'F8FAFC' },
                    borders: { top: tableBorder, bottom: tableBorder, left: tableBorder, right: tableBorder },
                    children: [new Paragraph({ children: [new TextRun({ text: '$1,240.00', bold: true, color: '059669' })] })],
                  }),
                ],
              }),
              new TableRow({
                children: [
                  new TableCell({
                    shading: { fill: 'FFFFFF' },
                    borders: { top: tableBorder, bottom: tableBorder, left: tableBorder, right: tableBorder },
                    children: [new Paragraph({ children: [new TextRun({ text: 'Customs Clearance & Handling', color: '1E293B' })] })],
                  }),
                  new TableCell({
                    shading: { fill: 'FFFFFF' },
                    borders: { top: tableBorder, bottom: tableBorder, left: tableBorder, right: tableBorder },
                    children: [new Paragraph({ children: [new TextRun({ text: '1 entry', color: '1E293B' })] })],
                  }),
                  new TableCell({
                    shading: { fill: 'FFFFFF' },
                    borders: { top: tableBorder, bottom: tableBorder, left: tableBorder, right: tableBorder },
                    children: [new Paragraph({ children: [new TextRun({ text: '$310.00', bold: true, color: '059669' })] })],
                  }),
                ],
              }),
            ],
          }),
          new Paragraph({
            alignment: AlignmentType.RIGHT,
            spacing: { before: 240 },
            children: [
              new TextRun({
                text: 'Total Balance Due: $1,550.00 USD',
                bold: true,
                size: 28,
                color: 'E11D48',
              }),
            ],
          }),

          // --- Explicit Page Break to guarantee 2+ pages ---
          new Paragraph({
            children: [new PageBreak()],
          }),

          // --- PAGE 2: Service Specifications, Policy Callout, Schedule Table ---
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            children: [
              new TextRun({
                text: 'Section 2: Terms & SLA Specifications',
                bold: true,
                color: '1E3A8A',
                size: 28,
              }),
            ],
          }),
          new Paragraph({
            style: 'Callout',
            children: [
              new TextRun({
                text: 'SECURITY NOTICE: All audit trails and cryptographic signatures are verified on-premise without telemetry.',
                color: '1E40AF',
                bold: true,
              }),
            ],
          }),
          new Paragraph({
            spacing: { before: 120, after: 120 },
            children: [
              new TextRun({
                text: 'Detailed SLA breakdown for scheduled delivery checkpoints:',
                italics: true,
                color: '475569',
              }),
            ],
          }),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              new TableRow({
                children: [
                  new TableCell({
                    shading: { fill: '0284C7' },
                    borders: { top: tableBorder, bottom: tableBorder, left: tableBorder, right: tableBorder },
                    children: [new Paragraph({ children: [new TextRun({ text: 'Milestone', bold: true, color: 'FFFFFF' })] })],
                  }),
                  new TableCell({
                    shading: { fill: '0284C7' },
                    borders: { top: tableBorder, bottom: tableBorder, left: tableBorder, right: tableBorder },
                    children: [new Paragraph({ children: [new TextRun({ text: 'SLA Window', bold: true, color: 'FFFFFF' })] })],
                  }),
                  new TableCell({
                    shading: { fill: '0284C7' },
                    borders: { top: tableBorder, bottom: tableBorder, left: tableBorder, right: tableBorder },
                    children: [new Paragraph({ children: [new TextRun({ text: 'Compliance', bold: true, color: 'FFFFFF' })] })],
                  }),
                ],
              }),
              new TableRow({
                children: [
                  new TableCell({
                    borders: { top: tableBorder, bottom: tableBorder, left: tableBorder, right: tableBorder },
                    children: [new Paragraph('Initial Processing')],
                  }),
                  new TableCell({
                    borders: { top: tableBorder, bottom: tableBorder, left: tableBorder, right: tableBorder },
                    children: [new Paragraph('< 4 Hours')],
                  }),
                  new TableCell({
                    borders: { top: tableBorder, bottom: tableBorder, left: tableBorder, right: tableBorder },
                    children: [new Paragraph({ children: [new TextRun({ text: '100% Met', color: '059669', bold: true })] })],
                  }),
                ],
              }),
              new TableRow({
                children: [
                  new TableCell({
                    borders: { top: tableBorder, bottom: tableBorder, left: tableBorder, right: tableBorder },
                    children: [new Paragraph('Transit Clearance')],
                  }),
                  new TableCell({
                    borders: { top: tableBorder, bottom: tableBorder, left: tableBorder, right: tableBorder },
                    children: [new Paragraph('< 24 Hours')],
                  }),
                  new TableCell({
                    borders: { top: tableBorder, bottom: tableBorder, left: tableBorder, right: tableBorder },
                    children: [new Paragraph({ children: [new TextRun({ text: '100% Met', color: '059669', bold: true })] })],
                  }),
                ],
              }),
            ],
          }),
          new Paragraph({
            spacing: { before: 240 },
            children: [
              new TextRun({
                text: 'Authorized Signatory: John Doe, Operations Director — Verified Offline.',
                italics: true,
                color: '64748B',
                size: 18,
              }),
            ],
          }),
        ],
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  writeFileSync(resolve(OUT_DIR, 'test-document.docx'), buffer);
  writeFileSync(resolve(OUT_DIR, 'sample-document.docx'), buffer);
  console.log('  wrote test-document.docx (2 pages, tables, callouts, colored spans)');
}

async function buildMultiPagePdf(): Promise<void> {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const bodyFont = await pdfDoc.embedFont(StandardFonts.Helvetica);

  // Page 1: portrait, title + colored vector shapes
  const p1 = pdfDoc.addPage([612, 792]);
  p1.drawText('Fixture Document - Page 1', { x: 60, y: 720, size: 26, font, color: rgb(0.11, 0.16, 0.33) });
  p1.drawRectangle({ x: 60, y: 620, width: 200, height: 60, color: rgb(0.86, 0.15, 0.15) });
  p1.drawEllipse({ x: 400, y: 650, xScale: 60, yScale: 40, color: rgb(0.02, 0.59, 0.41) });
  p1.drawText('Page 1 of 4 — portrait, embedded color', { x: 60, y: 60, size: 11, font: bodyFont, color: rgb(0.3, 0.3, 0.3) });

  // Page 2: landscape, table-like grid of colored cells + body text
  const p2 = pdfDoc.addPage([792, 612]);
  p2.drawText('Regional Summary - Page 2', { x: 50, y: 550, size: 20, font, color: rgb(0.11, 0.16, 0.33) });
  const colors = [rgb(0.86, 0.15, 0.15), rgb(0.02, 0.59, 0.41), rgb(0.02, 0.51, 0.78), rgb(0.96, 0.62, 0.04)];
  colors.forEach((c, i) => {
    p2.drawRectangle({ x: 50 + i * 160, y: 440, width: 140, height: 70, color: c });
  });
  p2.drawText(
    'This landscape page mixes vector fills with body text to exercise position-aware extraction.',
    { x: 50, y: 380, size: 12, font: bodyFont, color: rgb(0.2, 0.2, 0.2), maxWidth: 690 }
  );
  p2.drawText('Page 2 of 4 — landscape', { x: 50, y: 40, size: 11, font: bodyFont, color: rgb(0.3, 0.3, 0.3) });

  // Page 3: portrait, rotated text + line art
  const p3 = pdfDoc.addPage([612, 792]);
  p3.drawText('Rotated & Lines - Page 3', { x: 60, y: 720, size: 20, font, color: rgb(0.11, 0.16, 0.33) });
  p3.drawText('Diagonal watermark-style text', {
    x: 200,
    y: 400,
    size: 24,
    font,
    color: rgb(0.6, 0.6, 0.9),
    rotate: degrees(30),
    opacity: 0.5,
  });
  p3.drawLine({ start: { x: 60, y: 300 }, end: { x: 550, y: 300 }, thickness: 3, color: rgb(0.86, 0.15, 0.15) });
  p3.drawLine({ start: { x: 60, y: 280 }, end: { x: 550, y: 280 }, thickness: 1, color: rgb(0.3, 0.3, 0.3) });
  p3.drawText('Page 3 of 4 — portrait, rotation + line art', { x: 60, y: 60, size: 11, font: bodyFont, color: rgb(0.3, 0.3, 0.3) });

  // Page 4: landscape, closing page with a bordered box
  const p4 = pdfDoc.addPage([792, 612]);
  p4.drawText('Closing Page - Page 4', { x: 50, y: 550, size: 20, font, color: rgb(0.11, 0.16, 0.33) });
  p4.drawRectangle({
    x: 50,
    y: 250,
    width: 300,
    height: 150,
    borderColor: rgb(0.29, 0.33, 0.64),
    borderWidth: 3,
    color: rgb(0.95, 0.95, 0.98),
  });
  p4.drawText('Bordered box for crop/watermark testing', { x: 65, y: 320, size: 12, font: bodyFont, color: rgb(0.2, 0.2, 0.2) });
  p4.drawText('Page 4 of 4 — landscape', { x: 50, y: 40, size: 11, font: bodyFont, color: rgb(0.3, 0.3, 0.3) });

  const bytes = await pdfDoc.save();
  writeFileSync(resolve(OUT_DIR, 'test-multi.pdf'), bytes);
  writeFileSync(resolve(OUT_DIR, 'sample-multi.pdf'), bytes);
  console.log('  wrote test-multi.pdf (4 pages, mixed portrait/landscape)');
}

async function main() {
  console.log(`Generating test fixtures into ${OUT_DIR}...`);
  await buildPresentation();
  await buildDocument();
  await buildMultiPagePdf();
  console.log('Done generating all test fixtures.');
}

main().catch((err) => {
  console.error('Fixture generation failed:', err);
  process.exit(1);
});
