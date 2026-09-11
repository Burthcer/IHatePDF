/**
 * Minimal ZIP archive reader (STORED + DEFLATE)
 * IHatePDF - 100% Client-Side Architecture
 *
 * Parses the central directory directly and decompresses DEFLATE entries
 * via the native `DecompressionStream('deflate-raw')` Web API — no
 * dependency needed (this is the read-side counterpart to
 * `zipWriter.ts`, which only ever needs to write STORED entries for
 * Split's "Extract All Pages"; reading arbitrary real-world .docx/.pptx
 * files needs DEFLATE support since that's what those tools compress with).
 */

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * Reads every entry of a ZIP archive into memory, keyed by their path
 * inside the archive (e.g. "ppt/slides/slide1.xml").
 */
export async function readZip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let eocdOffset = -1;
  const searchFloor = Math.max(0, bytes.length - 22 - 65536);
  for (let i = bytes.length - 22; i >= searchFloor; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error('Not a valid ZIP/Office archive (no end-of-central-directory record found).');
  }

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);

  const result = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();
  let ptr = cdOffset;

  for (let i = 0; i < totalEntries; i++) {
    const signature = view.getUint32(ptr, true);
    if (signature !== 0x02014b50) {
      throw new Error('Malformed ZIP central directory entry.');
    }

    const compMethod = view.getUint16(ptr + 10, true);
    const compSize = view.getUint32(ptr + 20, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localHeaderOffset = view.getUint32(ptr + 42, true);
    const name = decoder.decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));

    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const compData = bytes.subarray(dataStart, dataStart + compSize);

    if (compMethod === 0) {
      result.set(name, compData);
    } else if (compMethod === 8) {
      result.set(name, await inflateRaw(compData));
    } else if (!name.endsWith('/')) {
      throw new Error(`Unsupported compression method (${compMethod}) for archive entry "${name}".`);
    }

    ptr += 46 + nameLen + extraLen + commentLen;
  }

  return result;
}
