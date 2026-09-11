/**
 * PDF to PDF/A Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Adds a PDF/A-1B identification XMP metadata stream (the `pdfaid` schema
 * archival readers use to recognize a PDF/A file) via pdf-lib's low-level
 * context API (no high-level `setXMPMetadata` exists in pdf-lib).
 *
 * ponytail / honest limitation: this does not perform full ISO 19005
 * validation, does not embed a color ICC output intent profile, and does
 * not verify every font is embedded — the things a real PDF/A conformance
 * checker (e.g. veraPDF) validates. It identifies the document as PDF/A and
 * carries real metadata, but isn't a substitute for a dedicated validator
 * if formal archival compliance is a hard legal requirement.
 */

import { PDFDocument, PDFName } from 'pdf-lib';
import type {
  WorkerRequest,
  PdfToPdfaPayload,
  ProcessedPdfResult,
  WorkerIncomingMessage,
} from '../../types/worker';

function buildXmp(title: string): string {
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
   <pdfaid:part>1</pdfaid:part>
   <pdfaid:conformance>B</pdfaid:conformance>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${title.replace(/[<>&]/g, '')}</rdf:li></rdf:Alt></dc:title>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">
   <xmp:CreatorTool>IHatePDF</xmp:CreatorTool>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

self.addEventListener('message', async (event: MessageEvent<WorkerRequest<PdfToPdfaPayload>>) => {
  const { id, action, payload } = event.data;

  if (action !== 'PDF_TO_PDFA') return;

  const emitProgress = (progress: number, stage: string) => {
    const msg: WorkerIncomingMessage = { type: 'PROGRESS', payload: { id, progress, stage } };
    self.postMessage(msg);
  };

  try {
    const { fileBuffer, fileName } = payload;
    if (!fileBuffer) throw new Error('No PDF buffer provided.');

    emitProgress(20, 'Loading document...');
    const pdfDoc = await PDFDocument.load(fileBuffer);
    const cleanBaseName = fileName.replace(/\.[^/.]+$/, '');

    emitProgress(50, 'Writing PDF/A identification metadata...');
    pdfDoc.setProducer('IHatePDF (Client-Side)');
    const xmp = buildXmp(pdfDoc.getTitle() || cleanBaseName);
    const xmpBytes = new TextEncoder().encode(xmp);
    const metadataStream = pdfDoc.context.stream(xmpBytes, { Type: 'Metadata', Subtype: 'XML' });
    const metadataRef = pdfDoc.context.register(metadataStream);
    pdfDoc.catalog.set(PDFName.of('Metadata'), metadataRef);

    emitProgress(85, 'Saving PDF...');
    const bytes = await pdfDoc.save();
    const resultBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

    emitProgress(100, 'Done.');
    const result: ProcessedPdfResult = {
      fileName: `${cleanBaseName}_pdfa.pdf`,
      buffer: resultBuffer,
      size: resultBuffer.byteLength,
      pageCount: pdfDoc.getPageCount(),
    };
    const responseMsg: WorkerIncomingMessage<ProcessedPdfResult> = {
      type: 'RESPONSE',
      payload: { id, success: true, data: result },
    };
    (self as any).postMessage(responseMsg, [resultBuffer]);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to convert to PDF/A';
    const responseMsg: WorkerIncomingMessage = {
      type: 'RESPONSE',
      payload: { id, success: false, error: errorMsg },
    };
    self.postMessage(responseMsg);
  }
});
