/**
 * Pre-flight file security and format validation
 * IHatePDF - 100% Client-Side Architecture
 *
 * Enforces magic-byte preflight inspection to reject disguised or malformed files
 * before committing memory allocations or piping into Web Workers.
 */

const PDF_MAGIC_BYTES = [0x25, 0x50, 0x44, 0x46]; // "%PDF-"

/**
 * Validates the raw ArrayBuffer begins with PDF magic bytes (%PDF-).
 */
export function validatePdfBuffer(buffer: ArrayBuffer): boolean {
  if (!buffer || buffer.byteLength < 4) {
    return false;
  }

  const bytes = new Uint8Array(buffer, 0, 4);
  return (
    bytes[0] === PDF_MAGIC_BYTES[0] &&
    bytes[1] === PDF_MAGIC_BYTES[1] &&
    bytes[2] === PDF_MAGIC_BYTES[2] &&
    bytes[3] === PDF_MAGIC_BYTES[3]
  );
}

/**
 * Inspects the initial 4 bytes of a File object using FileReader/ArrayBuffer slice
 * and asserts equality against magic bytes [0x25, 0x50, 0x44, 0x46] ("%PDF-").
 *
 * Immediately rejects non-PDF payloads before allocating full document memory.
 */
export async function validatePdfHeader(file: File): Promise<boolean> {
  if (!file || file.size < 4) {
    return false;
  }

  return new Promise<boolean>((resolve) => {
    // Read only the first 4 bytes using a blob slice to avoid buffering entire file
    const slice = file.slice(0, 4);
    const reader = new FileReader();

    reader.onload = () => {
      try {
        if (!reader.result || !(reader.result instanceof ArrayBuffer)) {
          resolve(false);
          return;
        }
        resolve(validatePdfBuffer(reader.result));
      } catch {
        resolve(false);
      }
    };

    reader.onerror = () => {
      resolve(false);
    };

    reader.readAsArrayBuffer(slice);
  });
}

/**
 * Helper to safely read a validated File into a detached ArrayBuffer.
 */
export async function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  const isValid = await validatePdfHeader(file);
  if (!isValid) {
    throw new Error(`File "${file.name}" failed pre-flight security validation: Missing or invalid PDF magic bytes header.`);
  }

  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result);
      } else {
        reject(new Error(`Failed to read "${file.name}" into ArrayBuffer.`));
      }
    };
    reader.onerror = () => reject(reader.error || new Error(`Error reading file "${file.name}".`));
    reader.readAsArrayBuffer(file);
  });
}
