/**
 * Full-page JPEGs (Redact, Repair's visual fallback) handed over as Blobs and
 * embedded without reading them into memory: only the header is parsed, and
 * the image data is copied from the Blob when the PDF is written.
 */

import {
  JpegEmbedder,
  PDFName,
  PDFNumber,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
  type PDFDocument,
  type PDFPage,
  type PDFRef,
} from 'pdf-lib';
import { BlobSource, canReadBlobsSync } from './byteSource';
import { LazyRawStream } from './lazyPdf';

const HEADER_BYTES = 256 * 1024;

export interface EmbeddedImage {
  ref: PDFRef;
  width: number;
  height: number;
}

/** Embeds a JPEG (Blob or bytes) as an image XObject. */
export async function embedJpegSource(doc: PDFDocument, jpeg: Blob | ArrayBuffer): Promise<EmbeddedImage> {
  if (!(jpeg instanceof Blob) || !canReadBlobsSync()) {
    const bytes = new Uint8Array(jpeg instanceof Blob ? await jpeg.arrayBuffer() : jpeg);
    const img = await doc.embedJpg(bytes);
    return { ref: img.ref, width: img.width, height: img.height };
  }
  const header = new Uint8Array(await jpeg.slice(0, HEADER_BYTES).arrayBuffer());
  let info: JpegEmbedder;
  try {
    info = await JpegEmbedder.for(header);
  } catch {
    // Frame header beyond the first 256 KB (huge metadata): read it all.
    const img = await doc.embedJpg(new Uint8Array(await jpeg.arrayBuffer()));
    return { ref: img.ref, width: img.width, height: img.height };
  }
  const dict = doc.context.obj({
    Type: 'XObject',
    Subtype: 'Image',
    BitsPerComponent: info.bitsPerComponent,
    Width: info.width,
    Height: info.height,
    ColorSpace: info.colorSpace,
    Filter: 'DCTDecode',
    // Adobe CMYK JPEGs are stored inverted (as pdf-lib does).
    ...(info.colorSpace === 'DeviceCMYK' ? { Decode: [1, 0, 1, 0, 1, 0, 1, 0] } : {}),
  });
  dict.set(PDFName.of('Length'), PDFNumber.of(jpeg.size));
  const ref = doc.context.register(new LazyRawStream(dict, new BlobSource(jpeg), 0, jpeg.size));
  return { ref, width: info.width, height: info.height };
}

/** Draws `image` into the box (x, y, width, height) of `page`, in points. */
export function drawImageAt(page: PDFPage, image: EmbeddedImage, x: number, y: number, width: number, height: number) {
  const name = page.node.newXObject('Image', image.ref);
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(width, 0, 0, height, x, y), drawObject(name), popGraphicsState());
}

/** Draws `image` stretched over the whole of `page` (w×h points). */
export const drawImageFull = (page: PDFPage, image: EmbeddedImage, width: number, height: number) => drawImageAt(page, image, 0, 0, width, height);
