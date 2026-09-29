/**
 * PDF to PDF/A Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Best-effort PDF/A-2b (ISO 19005-2, level B). Fixes what can be fixed
 * mechanically:
 *  - removes encryption, JavaScript, launch actions and embedded files
 *  - adds an sRGB output intent (ICC profile generated here)
 *  - writes XMP metadata with the pdfaid schema, kept consistent with the
 *    document Info dictionary, and a file identifier
 *  - declares PDF 1.7
 * and reports what can't be fixed without re-creating the document (fonts
 * that aren't embedded). Formal conformance should still be checked with a
 * validator such as veraPDF when it's a legal requirement.
 */

import { PDFArray, PDFDict, PDFHexString, PDFName, PDFStream, PDFString, PDFHeader, type PDFDocument } from 'pdf-lib';
import { openPdf } from '../../services/pdfLoader';
import type { PdfToPdfaPayload, ProcessedPdfResult } from '../../types/worker';
import { emitPdf } from '../../services/workerEmit';
import { serveTask } from '../../services/workerTask';
import type { OutputSink } from '../../services/workerOutput';

// ------------------------------------------------------------ ICC profile

function buildSrgbIcc(): Uint8Array {
  const enc = new TextEncoder();
  const s15 = (v: number) => Math.round(v * 65536) | 0;
  const tags: Array<{ sig: string; data: Uint8Array }> = [];

  const desc = (() => {
    const text = 'sRGB IEC61966-2.1';
    const buf = new Uint8Array(12 + text.length + 1 + 8 + 3 + 67);
    const dv = new DataView(buf.buffer);
    buf.set(enc.encode('desc'), 0);
    dv.setUint32(8, text.length + 1);
    buf.set(enc.encode(text), 12);
    return buf;
  })();
  const cprt = (() => {
    const text = 'No copyright, use freely';
    const buf = new Uint8Array(8 + text.length + 1);
    buf.set(enc.encode('text'), 0);
    buf.set(enc.encode(text), 8);
    return buf;
  })();
  const xyz = (x: number, y: number, z: number) => {
    const buf = new Uint8Array(20);
    const dv = new DataView(buf.buffer);
    buf.set(enc.encode('XYZ '), 0);
    dv.setInt32(8, s15(x));
    dv.setInt32(12, s15(y));
    dv.setInt32(16, s15(z));
    return buf;
  };
  const curve = (() => {
    const buf = new Uint8Array(14);
    const dv = new DataView(buf.buffer);
    buf.set(enc.encode('curv'), 0);
    dv.setUint32(8, 1);
    dv.setUint16(12, 0x0233); // gamma ≈ 2.2
    return buf;
  })();

  tags.push({ sig: 'desc', data: desc });
  tags.push({ sig: 'cprt', data: cprt });
  tags.push({ sig: 'wtpt', data: xyz(0.9642, 1.0, 0.8249) });
  tags.push({ sig: 'rXYZ', data: xyz(0.4361, 0.2225, 0.0139) });
  tags.push({ sig: 'gXYZ', data: xyz(0.3851, 0.7169, 0.0971) });
  tags.push({ sig: 'bXYZ', data: xyz(0.1431, 0.0606, 0.7141) });
  tags.push({ sig: 'rTRC', data: curve });
  tags.push({ sig: 'gTRC', data: curve });
  tags.push({ sig: 'bTRC', data: curve });

  const tableSize = 4 + tags.length * 12;
  let offset = 128 + tableSize;
  const placed = tags.map((t) => {
    const at = offset;
    offset += Math.ceil(t.data.length / 4) * 4;
    return { ...t, at };
  });
  const total = offset;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, total);
  dv.setUint32(8, 0x02100000); // v2.1
  out.set(enc.encode('mntr'), 12);
  out.set(enc.encode('RGB '), 16);
  out.set(enc.encode('XYZ '), 20);
  dv.setUint16(24, 2024);
  dv.setUint16(26, 1);
  dv.setUint16(28, 1);
  out.set(enc.encode('acsp'), 36);
  dv.setInt32(68, s15(0.9642));
  dv.setInt32(72, s15(1.0));
  dv.setInt32(76, s15(0.8249));
  dv.setUint32(128, tags.length);
  placed.forEach((t, i) => {
    const e = 132 + i * 12;
    out.set(enc.encode(t.sig), e);
    dv.setUint32(e + 4, t.at);
    dv.setUint32(e + 8, t.data.length);
    out.set(t.data, t.at);
  });
  return out;
}

// ------------------------------------------------------------ helpers

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function isoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const tz = -d.getTimezoneOffset();
  const sign = tz >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(Math.abs(tz) / 60))}:${pad(Math.abs(tz) % 60)}`;
}

function buildXmp(meta: { title?: string; author?: string; subject?: string; keywords?: string; producer: string; creator: string; created: Date; modified: Date }): string {
  const opt = (tag: string, value?: string) => (value ? `   <${tag}>${xmlEscape(value)}</${tag}>\n` : '');
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
   <pdfaid:part>2</pdfaid:part>
   <pdfaid:conformance>B</pdfaid:conformance>
${meta.title ? `   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xmlEscape(meta.title)}</rdf:li></rdf:Alt></dc:title>\n` : ''}${meta.author ? `   <dc:creator><rdf:Seq><rdf:li>${xmlEscape(meta.author)}</rdf:li></rdf:Seq></dc:creator>\n` : ''}${meta.subject ? `   <dc:description><rdf:Alt><rdf:li xml:lang="x-default">${xmlEscape(meta.subject)}</rdf:li></rdf:Alt></dc:description>\n` : ''}${opt('pdf:Keywords', meta.keywords)}   <pdf:Producer>${xmlEscape(meta.producer)}</pdf:Producer>
   <xmp:CreatorTool>${xmlEscape(meta.creator)}</xmp:CreatorTool>
   <xmp:CreateDate>${isoDate(meta.created)}</xmp:CreateDate>
   <xmp:ModifyDate>${isoDate(meta.modified)}</xmp:ModifyDate>
   <xmp:MetadataDate>${isoDate(meta.modified)}</xmp:MetadataDate>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
${' '.repeat(2000)}
<?xpacket end="w"?>`;
}

function findUnembeddedFonts(doc: PDFDocument): string[] {
  const names = new Set<string>();
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    const type = obj.lookup(PDFName.of('Type'));
    if (!(type instanceof PDFName) || type.decodeText() !== 'Font') continue;
    const subtype = obj.lookup(PDFName.of('Subtype'));
    if (subtype instanceof PDFName && (subtype.decodeText() === 'Type3' || subtype.decodeText() === 'Type0')) continue;
    const desc = obj.lookup(PDFName.of('FontDescriptor'));
    const embedded = desc instanceof PDFDict && ['FontFile', 'FontFile2', 'FontFile3'].some((k) => desc.has(PDFName.of(k)));
    if (!embedded) {
      const base = obj.lookup(PDFName.of('BaseFont'));
      names.add(base instanceof PDFName ? base.decodeText() : 'unnamed');
    }
  }
  return [...names];
}

function stripActions(doc: PDFDocument): number {
  let removed = 0;
  const catalog = doc.catalog;
  const names = catalog.lookup(PDFName.of('Names'));
  if (names instanceof PDFDict) {
    for (const key of ['JavaScript', 'EmbeddedFiles']) {
      if (names.has(PDFName.of(key))) {
        names.delete(PDFName.of(key));
        removed++;
      }
    }
  }
  for (const key of ['AA', 'OpenAction']) {
    const v = catalog.lookup(PDFName.of(key));
    if (key === 'AA' && v) {
      catalog.delete(PDFName.of(key));
      removed++;
    }
    if (key === 'OpenAction' && v instanceof PDFDict) {
      const s = v.lookup(PDFName.of('S'));
      if (s instanceof PDFName && ['JavaScript', 'Launch'].includes(s.decodeText())) {
        catalog.delete(PDFName.of(key));
        removed++;
      }
    }
  }
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const dict = obj instanceof PDFStream ? obj.dict : obj instanceof PDFDict ? obj : null;
    if (!dict) continue;
    if (dict.has(PDFName.of('AA'))) {
      dict.delete(PDFName.of('AA'));
      removed++;
    }
    const a = dict.lookup(PDFName.of('A'));
    if (a instanceof PDFDict) {
      const s = a.lookup(PDFName.of('S'));
      if (s instanceof PDFName && ['JavaScript', 'Launch', 'ImportData', 'ResetForm', 'SubmitForm'].includes(s.decodeText())) {
        dict.delete(PDFName.of('A'));
        removed++;
      }
    }
  }
  return removed;
}

export async function convertToPdfa(payload: PdfToPdfaPayload, onProgress?: (p: number, s: string) => void, sink?: OutputSink): Promise<ProcessedPdfResult> {
  const { fileBuffer, fileName } = payload;
  onProgress?.(15, 'Loading document...');
  const pdfDoc = await openPdf(fileBuffer);
  const base = fileName.replace(/\.[^/.]+$/, '');

  onProgress?.(35, 'Removing scripts, actions and attachments...');
  const removedActions = stripActions(pdfDoc);

  onProgress?.(50, 'Adding sRGB output intent...');
  const context = pdfDoc.context;
  const icc = context.flateStream(buildSrgbIcc(), { N: 3 });
  const iccRef = context.register(icc);
  const intent = context.obj({
    Type: 'OutputIntent',
    S: 'GTS_PDFA1',
    OutputConditionIdentifier: PDFString.of('sRGB IEC61966-2.1'),
    Info: PDFString.of('sRGB IEC61966-2.1'),
    RegistryName: PDFString.of('http://www.color.org'),
    DestOutputProfile: iccRef,
  });
  pdfDoc.catalog.set(PDFName.of('OutputIntents'), context.obj([intent]));

  onProgress?.(65, 'Writing archival metadata...');
  const now = new Date();
  const created = pdfDoc.getCreationDate() ?? now;
  const title = pdfDoc.getTitle() || base;
  pdfDoc.setTitle(title);
  pdfDoc.setProducer('IHatePDF');
  pdfDoc.setCreationDate(created);
  pdfDoc.setModificationDate(now);
  const xmp = buildXmp({
    title,
    author: pdfDoc.getAuthor(),
    subject: pdfDoc.getSubject(),
    keywords: pdfDoc.getKeywords(),
    producer: 'IHatePDF',
    creator: pdfDoc.getCreator() || 'IHatePDF',
    created,
    modified: now,
  });
  const metadata = context.stream(new TextEncoder().encode(xmp), { Type: 'Metadata', Subtype: 'XML' });
  pdfDoc.catalog.set(PDFName.of('Metadata'), context.register(metadata));
  pdfDoc.catalog.delete(PDFName.of('NeedsRendering'));
  const acro = pdfDoc.catalog.lookup(PDFName.of('AcroForm'));
  if (acro instanceof PDFDict) {
    acro.delete(PDFName.of('XFA'));
    acro.delete(PDFName.of('NeedAppearances'));
  }

  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  context.trailerInfo.ID = context.obj([PDFHexString.of(id), PDFHexString.of(id)]) as PDFArray;
  context.header = PDFHeader.forVersion(1, 7);

  const unembedded = findUnembeddedFonts(pdfDoc);

  onProgress?.(85, 'Saving PDF...');
  const out = await emitPdf(pdfDoc, sink, { useObjectStreams: false });
  onProgress?.(100, 'Done.');

  const notes: string[] = [];
  if (removedActions) notes.push(`Removed ${removedActions} script/action/attachment entr${removedActions === 1 ? 'y' : 'ies'}.`);
  if (unembedded.length) notes.push(`Not fully compliant: ${unembedded.length} font${unembedded.length === 1 ? ' isn’t' : 's aren’t'} embedded (${unembedded.slice(0, 4).join(', ')}${unembedded.length > 4 ? '…' : ''}). Re-export from the source application with fonts embedded.`);
  return { fileName: `${base}_pdfa.pdf`, ...out, pageCount: pdfDoc.getPageCount(), note: notes.join(' ') || 'PDF/A-2b structure written.' };
}

serveTask<PdfToPdfaPayload, ProcessedPdfResult>('PDF_TO_PDFA', (p, ctx) => convertToPdfa(p, ctx.progress, ctx.sink()), 'Failed to convert to PDF/A');
