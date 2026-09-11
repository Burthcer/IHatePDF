/**
 * Test fixture generator — IHatePDF
 *
 * Builds real, styled, non-trivial documents used to verify the high-
 * fidelity conversion pipelines (see scripts/test-all-features.ts). These
 * are genuine .pptx/.docx/.pdf files (not stubs) — a colored 2x2 table and
 * a gradient background you can actually open in PowerPoint, a docx with a
 * real named "Callout" style and an invoice table, a 4-page PDF mixing
 * portrait/landscape with real vector shapes.
 *
 * Run: npx tsx scripts/generateTestFixtures.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pptxgen from 'pptxgenjs';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, AlignmentType } from 'docx';
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import { readZip } from '../src/services/zipReader';
import { createZip } from '../src/services/zipWriter';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'test-fixtures');
mkdirSync(OUT_DIR, { recursive: true });

async function buildPresentation(): Promise<void> {
  const pres = new pptxgen();
  pres.defineLayout({ name: 'WIDE', width: 10, height: 5.63 });
  pres.layout = 'WIDE';

  // Slide 1: dark theme, colored header, bullets, 2x2 colored table, a shape.
  const s1 = pres.addSlide();
  s1.background = { color: '111827' };
  s1.addText('Quarterly Report', {
    x: 0.5, y: 0.35, w: 9, h: 0.8, fontSize: 32, bold: true, color: 'E11D48', fontFace: 'Arial',
  });
  s1.addText(
    [
      { text: 'Revenue grew 24% year over year', options: { bullet: true, breakLine: true } },
      { text: 'Client retention held above 92%', options: { bullet: true, breakLine: true } },
      { text: 'Three new markets opened in Q3', options: { bullet: true } },
    ],
    { x: 0.5, y: 1.3, w: 4.3, h: 1.8, fontSize: 16, color: 'F1F5F9', fontFace: 'Arial' }
  );
  s1.addShape(pres.ShapeType.rect, { x: 7.3, y: 1.3, w: 2.0, h: 1.0, fill: { color: 'F59E0B' } });
  s1.addTable(
    [
      [
        { text: 'Region', options: { fill: { color: '374151' }, color: 'FFFFFF', bold: true } },
        { text: 'Growth', options: { fill: { color: '374151' }, color: 'FFFFFF', bold: true } },
      ],
      [
        { text: 'EMEA', options: { fill: { color: '1F2937' }, color: 'F1F5F9' } },
        { text: '+18%', options: { fill: { color: '1F2937' }, color: '34D399' } },
      ],
      [
        { text: 'APAC', options: { fill: { color: '111827' }, color: 'F1F5F9' } },
        { text: '+31%', options: { fill: { color: '111827' }, color: '34D399' } },
      ],
    ],
    { x: 0.5, y: 3.3, w: 5.0, h: 1.5, fontSize: 12, border: { color: '4B5563', pt: 1 } }
  );

  // Slide 2: gradient background (pptxgenjs has no gradient-fill API — the
  // slide is built normally, then its <p:bg> is hand-patched into real
  // DrawingML gradFill XML below), plus two side-by-side ("multi-column")
  // styled text boxes.
  const s2 = pres.addSlide();
  s2.addText('Two-Column Layout', { x: 0.5, y: 0.3, w: 9, h: 0.6, fontSize: 24, bold: true, color: 'FFFFFF' });
  s2.addText('The left column covers highlights from the first half of the year, written in a clean sans-serif at 14pt.', {
    x: 0.5, y: 1.2, w: 4.2, h: 3.5, fontSize: 14, color: 'FFFFFF', fontFace: 'Arial',
  });
  s2.addText('The right column mirrors it for the second half, positioned independently so both blocks keep distinct real coordinates.', {
    x: 5.1, y: 1.2, w: 4.2, h: 3.5, fontSize: 14, color: 'FFFFFF', fontFace: 'Arial',
  });

  // Slide 3: tests placeholder inheritance (no xfrm in slide XML), multiline text
  // with small initial height, runs with attributes (dirty="0"), and an embedded image.
  const s3 = pres.addSlide();
  s3.background = { color: '0F172A' };
  s3.addText('Placeholder Slide Title', { x: 0.5, y: 0.5, w: 9, h: 0.8, fontSize: 28, bold: true, color: '38BDF8' });
  s3.addText(
    'This is line one.\nThis is line two of multiline text.\nThis is line three that should never be truncated even with small box height.',
    { x: 0.5, y: 1.5, w: 8, h: 0.3, fontSize: 14, color: 'E2E8F0' }
  );

  const buffer = (await pres.write({ outputType: 'nodebuffer' })) as Buffer;

  // Patch slide2's background to a real linear gradient fill.
  const entries = await readZip(new Uint8Array(buffer));
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const slide2Name = 'ppt/slides/slide2.xml';
  let slide2Xml = decoder.decode(entries.get(slide2Name)!);
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

  // Patch slide 3: strip xfrm from the title shape and inject <p:ph type="title"/>
  // to simulate a standard PowerPoint placeholder shape with inherited layout coords.
  const slide3Name = 'ppt/slides/slide3.xml';
  if (entries.has(slide3Name)) {
    let slide3Xml = decoder.decode(entries.get(slide3Name)!);
    // Replace first <p:spPr> with an empty one plus placeholder in nvPr
    slide3Xml = slide3Xml.replace(
      /(<p:sp>[\s\S]*?<p:nvPr>)([\s\S]*?<\/p:nvPr>[\s\S]*?)<p:spPr>[\s\S]*?<\/p:spPr>/,
      '$1<p:ph type="title"/>$2<p:spPr/>'
    );
    // Add dirty="0" attribute to runs to test attribute resilience
    slide3Xml = slide3Xml.replace(/<a:r>/g, '<a:r dirty="0">');

    // Add a 1x1 transparent PNG image embedded via <p:pic>
    const samplePng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64'
    );
    entries.set('ppt/media/image1.png', samplePng);

    // Update slide3 rels with image relationship
    const slide3RelsName = 'ppt/slides/_rels/slide3.xml.rels';
    const slide3Rels =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
      '  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>\n' +
      '  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>\n' +
      '</Relationships>';
    entries.set(slide3RelsName, encoder.encode(slide3Rels));

    // Inject <p:pic> into slide3
    const picXml =
      '<p:pic>' +
      '<p:nvPicPr><p:cNvPr id="99" name="Logo"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>' +
      '<p:blipFill><a:blip r:embed="rId2"/></p:blipFill>' +
      '<p:spPr><a:xfrm><a:off x="5000000" y="500000"/><a:ext cx="600000" cy="600000"/></a:xfrm></p:spPr>' +
      '</p:pic>';
    slide3Xml = slide3Xml.replace('</p:spTree>', `${picXml}</p:spTree>`);
    entries.set(slide3Name, encoder.encode(slide3Xml));
  }

  // Inject an ORPHANED slide (slide99.xml) that is NOT in presentation.xml sldIdLst.
  // This simulates a slide deleted in PowerPoint that left unlinked XML in the zip.
  const orphanedSlideXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">\n' +
    '  <p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree>\n' +
    '</p:sld>';
  entries.set('ppt/slides/slide99.xml', encoder.encode(orphanedSlideXml));

  const zipEntries = Array.from(entries.entries()).map(([name, data]) => ({ name, data }));
  const finalBuffer = createZip(zipEntries);
  writeFileSync(resolve(OUT_DIR, 'sample-presentation.pptx'), finalBuffer);
  console.log('  wrote sample-presentation.pptx');
}

async function buildDocument(): Promise<void> {
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
        children: [
          new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun('Invoice #4471')] }),
          new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun('Acme Logistics Ltd.')] }),
          new Paragraph({
            style: 'Callout',
            children: [new TextRun('Payment due within 14 days of receipt. Late payments accrue 1.5% monthly interest.')],
          }),
          new Paragraph({
            children: [
              new TextRun('This invoice covers services rendered in '),
              new TextRun({ text: 'March 2026', bold: true }),
              new TextRun(', including '),
              new TextRun({ text: 'expedited freight handling', italics: true }),
              new TextRun(' across two shipments.'),
            ],
          }),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              new TableRow({
                children: [
                  new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: 'Item', bold: true })] })] }),
                  new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: 'Qty', bold: true })] })] }),
                  new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: 'Amount', bold: true })] })] }),
                ],
              }),
              new TableRow({
                children: [
                  new TableCell({ children: [new Paragraph('Freight handling')] }),
                  new TableCell({ children: [new Paragraph('2')] }),
                  new TableCell({ children: [new Paragraph('$1,240.00')] }),
                ],
              }),
              new TableRow({
                children: [
                  new TableCell({ children: [new Paragraph('Customs clearance')] }),
                  new TableCell({ children: [new Paragraph('1')] }),
                  new TableCell({ children: [new Paragraph('$310.00')] }),
                ],
              }),
            ],
          }),
          new Paragraph({
            alignment: AlignmentType.RIGHT,
            spacing: { before: 300 },
            children: [new TextRun({ text: 'Total due: $1,550.00', bold: true, size: 28 })],
          }),
        ],
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  writeFileSync(resolve(OUT_DIR, 'sample-document.docx'), buffer);
  console.log('  wrote sample-document.docx');
}

async function buildMultiPagePdf(): Promise<void> {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const bodyFont = await pdfDoc.embedFont(StandardFonts.Helvetica);

  // Page 1: portrait, title + colored vector shapes.
  const p1 = pdfDoc.addPage([612, 792]);
  p1.drawText('Fixture Document', { x: 60, y: 720, size: 26, font, color: rgb(0.11, 0.16, 0.33) });
  p1.drawRectangle({ x: 60, y: 620, width: 200, height: 60, color: rgb(0.86, 0.15, 0.15) });
  p1.drawEllipse({ x: 400, y: 650, xScale: 60, yScale: 40, color: rgb(0.02, 0.59, 0.41) });
  p1.drawText('Page 1 of 4 — portrait, embedded color', { x: 60, y: 60, size: 11, font: bodyFont, color: rgb(0.3, 0.3, 0.3) });

  // Page 2: landscape, table-ish grid of colored cells + body text.
  const p2 = pdfDoc.addPage([792, 612]);
  p2.drawText('Regional Summary', { x: 50, y: 550, size: 20, font, color: rgb(0.11, 0.16, 0.33) });
  const colors = [rgb(0.86, 0.15, 0.15), rgb(0.02, 0.59, 0.41), rgb(0.02, 0.51, 0.78), rgb(0.96, 0.62, 0.04)];
  colors.forEach((c, i) => {
    p2.drawRectangle({ x: 50 + i * 160, y: 440, width: 140, height: 70, color: c });
  });
  p2.drawText(
    'This landscape page mixes vector fills with body text to exercise position-aware extraction.',
    { x: 50, y: 380, size: 12, font: bodyFont, color: rgb(0.2, 0.2, 0.2), maxWidth: 690 }
  );
  p2.drawText('Page 2 of 4 — landscape', { x: 50, y: 40, size: 11, font: bodyFont, color: rgb(0.3, 0.3, 0.3) });

  // Page 3: portrait, rotated text + line art.
  const p3 = pdfDoc.addPage([612, 792]);
  p3.drawText('Rotated & Lines', { x: 60, y: 720, size: 20, font, color: rgb(0.11, 0.16, 0.33) });
  p3.drawText('Diagonal watermark-style text', {
    x: 200, y: 400, size: 24, font, color: rgb(0.6, 0.6, 0.9), rotate: degrees(30), opacity: 0.5,
  });
  p3.drawLine({ start: { x: 60, y: 300 }, end: { x: 550, y: 300 }, thickness: 3, color: rgb(0.86, 0.15, 0.15) });
  p3.drawLine({ start: { x: 60, y: 280 }, end: { x: 550, y: 280 }, thickness: 1, color: rgb(0.3, 0.3, 0.3) });
  p3.drawText('Page 3 of 4 — portrait, rotation + line art', { x: 60, y: 60, size: 11, font: bodyFont, color: rgb(0.3, 0.3, 0.3) });

  // Page 4: landscape, closing page with a bordered box.
  const p4 = pdfDoc.addPage([792, 612]);
  p4.drawText('Closing Page', { x: 50, y: 550, size: 20, font, color: rgb(0.11, 0.16, 0.33) });
  p4.drawRectangle({
    x: 50, y: 250, width: 300, height: 150, borderColor: rgb(0.29, 0.33, 0.64), borderWidth: 3, color: rgb(0.95, 0.95, 0.98),
  });
  p4.drawText('Bordered box for crop/watermark testing', { x: 65, y: 320, size: 12, font: bodyFont, color: rgb(0.2, 0.2, 0.2) });
  p4.drawText('Page 4 of 4 — landscape', { x: 50, y: 40, size: 11, font: bodyFont, color: rgb(0.3, 0.3, 0.3) });

  const bytes = await pdfDoc.save();
  writeFileSync(resolve(OUT_DIR, 'sample-multi.pdf'), bytes);
  console.log('  wrote sample-multi.pdf');
}

async function main() {
  console.log(`Generating test fixtures into ${OUT_DIR}...`);
  await buildPresentation();
  await buildDocument();
  await buildMultiPagePdf();
  console.log('Done.');
}

main().catch((err) => {
  console.error('Fixture generation failed:', err);
  process.exit(1);
});
