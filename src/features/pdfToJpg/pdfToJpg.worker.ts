/**
 * PDF to JPG Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Packs already-rendered page images (rendered on the main thread via
 * usePdfRenderer, same as PDF -> PPTX) into a ZIP. Images arrive as Blobs
 * and the ZIP is streamed out entry by entry, so neither the images nor the
 * archive are ever held in memory all at once.
 */

import { ZipStreamWriter } from '../../services/zipWriter';
import { emitBytes } from '../../services/workerEmit';
import { serveTask } from '../../services/workerTask';
import type { OutputSink } from '../../services/workerOutput';
import type { BuildJpgZipPayload, ProcessedPdfResult } from '../../types/worker';

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function bytesOf(img: BuildJpgZipPayload['images'][number]): Promise<Uint8Array> {
  if (!('bytes' in img) || !img.bytes) return dataUrlToBytes(img.dataUrl!);
  return new Uint8Array(img.bytes instanceof Blob ? await img.bytes.arrayBuffer() : img.bytes.slice(0));
}

export async function buildJpgZip(payload: BuildJpgZipPayload, onProgress: (p: number, s: string) => void, sink?: OutputSink): Promise<ProcessedPdfResult> {
  const { images, fileName } = payload;
  const ext = payload.ext ?? 'jpg';
  if (!images || images.length === 0) throw new Error('No rendered pages to export.');
  const cleanBaseName = fileName.replace(/\.[^/.]+$/, '');

  if (images.length === 1) {
    onProgress(60, 'Preparing image...');
    const out = await emitBytes(await bytesOf(images[0]), sink);
    onProgress(100, 'Image ready.');
    return { fileName: `${cleanBaseName}_page_${images[0].pageNumber}.${ext}`, ...out };
  }

  const pad = String(Math.max(...images.map((i) => i.pageNumber))).length;
  const parts: Uint8Array[] = [];
  const target = sink ?? { write: (c: Uint8Array) => void parts.push(c) };
  const zip = new ZipStreamWriter(target);
  for (let i = 0; i < images.length; i++) {
    onProgress(10 + Math.round((i / images.length) * 85), `Packaging image ${i + 1} of ${images.length}...`);
    const img = images[i];
    const data = await bytesOf(img);
    await zip.addEntry(`${cleanBaseName}_page_${String(img.pageNumber).padStart(pad, '0')}.${ext}`, async (s) => s.write(data));
  }
  await zip.finish();
  onProgress(100, 'ZIP ready.');
  const name = `${cleanBaseName}_pages.zip`;
  if (sink) {
    const output = await sink.close();
    return { fileName: name, output, size: output.size, pageCount: images.length };
  }
  const buffer = await new Blob(parts as BlobPart[]).arrayBuffer();
  return { fileName: name, buffer, size: buffer.byteLength, pageCount: images.length };
}

serveTask<BuildJpgZipPayload, ProcessedPdfResult>('BUILD_JPG_ZIP', (p, ctx) => buildJpgZip(p, ctx.progress, ctx.sink()), 'Failed to export images');
