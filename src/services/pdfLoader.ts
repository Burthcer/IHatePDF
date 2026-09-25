/**
 * The one place PDFs are loaded into pdf-lib.
 *
 * `PDFDocument.load` on its own refuses every encrypted file — including the
 * very common "owner password only" files (bank statements, e-tickets,
 * government forms) that any viewer opens without asking for anything. It
 * also can't read encrypted object streams at all. `openPdf` handles both:
 *
 *  1. Load normally when the file isn't encrypted.
 *  2. Otherwise authenticate the password (empty first, then the supplied
 *     one) against the /Encrypt dictionary, re-parse with object streams
 *     decrypted on the fly, then decrypt every remaining string and stream
 *     in place and drop /Encrypt — leaving a plain, fully editable document.
 *
 * pdf-lib exposes no hook for step 2's "decrypt object streams before
 * parsing them", so two parser methods are wrapped for the duration of that
 * one load (serialized by a lock, so concurrent loads can't interfere).
 */

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFObjectStreamParser,
  PDFParser,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  ParseSpeeds,
  decodePDFRawStream,
} from 'pdf-lib';
import { createSecurityHandler, firstFileId, type SecurityHandler } from './pdfSecurity';
import { bytesToHex } from './pdfCrypto';

export class PdfPasswordError extends Error {
  readonly code: 'PASSWORD_REQUIRED' | 'PASSWORD_INCORRECT';
  constructor(code: 'PASSWORD_REQUIRED' | 'PASSWORD_INCORRECT') {
    super(
      code === 'PASSWORD_REQUIRED'
        ? 'This PDF is password protected. Enter its password to open it.'
        : 'Incorrect password.'
    );
    this.name = 'PdfPasswordError';
    this.code = code;
  }
}

export interface OpenPdfOptions {
  password?: string;
}

export interface OpenedPdfInfo {
  wasEncrypted: boolean;
}

const LOAD_OPTIONS = {
  ignoreEncryption: true,
  updateMetadata: false,
  throwOnInvalidObject: false,
  parseSpeed: ParseSpeeds.Fastest,
} as const;

const ENCRYPT_TOKEN = [0x2f, 0x45, 0x6e, 0x63, 0x72, 0x79, 0x70, 0x74]; // "/Encrypt"

function containsEncryptToken(bytes: Uint8Array): boolean {
  outer: for (let i = 0; i <= bytes.length - ENCRYPT_TOKEN.length; i++) {
    if (bytes[i] !== 0x2f) continue;
    for (let j = 1; j < ENCRYPT_TOKEN.length; j++) {
      if (bytes[i + j] !== ENCRYPT_TOKEN[j]) continue outer;
    }
    return true;
  }
  return false;
}

function toBytes(input: ArrayBuffer | Uint8Array): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

let parserLock: Promise<unknown> = Promise.resolve();

type ForStream = typeof PDFObjectStreamParser.forStream;

/** Runs `fn` with PDFObjectStreamParser.forStream (and the header parser) swapped out. */
async function withPatchedParser<T>(
  makeForStream: (original: ForStream, currentRef: () => PDFRef | null) => ForStream,
  fn: () => Promise<T>
): Promise<T> {
  const run = async () => {
    const proto = PDFParser.prototype as unknown as { parseIndirectObjectHeader: () => PDFRef };
    const originalHeader = proto.parseIndirectObjectHeader;
    const originalForStream = PDFObjectStreamParser.forStream;
    let lastRef: PDFRef | null = null;
    proto.parseIndirectObjectHeader = function (this: unknown) {
      lastRef = originalHeader.call(this);
      return lastRef;
    };
    PDFObjectStreamParser.forStream = makeForStream(originalForStream, () => lastRef);
    try {
      return await fn();
    } finally {
      proto.parseIndirectObjectHeader = originalHeader;
      PDFObjectStreamParser.forStream = originalForStream;
    }
  };
  const next = parserLock.then(run, run);
  parserLock = next.catch(() => undefined);
  return next;
}

/** Object numbers stored inside a (decrypted) object stream. */
function objectNumbersInObjStm(stream: PDFRawStream): number[] {
  const n = stream.dict.lookup(PDFName.of('N'));
  const first = stream.dict.lookup(PDFName.of('First'));
  if (!(n instanceof PDFNumber) || !(first instanceof PDFNumber)) return [];
  const decoded = decodePDFRawStream(stream).decode();
  const header = new TextDecoder('latin1').decode(decoded.subarray(0, first.asNumber()));
  const nums = header.trim().split(/\s+/).map(Number);
  const out: number[] = [];
  for (let i = 0; i < n.asNumber() * 2 && i < nums.length; i += 2) out.push(nums[i]);
  return out;
}

async function decryptValue(
  value: PDFObject,
  handler: SecurityHandler,
  objNum: number,
  gen: number
): Promise<PDFObject> {
  if (value instanceof PDFString || value instanceof PDFHexString) {
    try {
      const plain = await handler.decryptString(value.asBytes(), objNum, gen);
      return PDFHexString.of(bytesToHex(plain));
    } catch {
      return value;
    }
  }
  if (value instanceof PDFArray) {
    for (let i = 0; i < value.size(); i++) {
      const child = value.get(i);
      const replaced = await decryptValue(child, handler, objNum, gen);
      if (replaced !== child) value.set(i, replaced);
    }
  } else if (value instanceof PDFDict) {
    for (const [key, child] of value.entries()) {
      const replaced = await decryptValue(child, handler, objNum, gen);
      if (replaced !== child) value.set(key, replaced);
    }
  }
  return value;
}

function isCryptIdentityStream(dict: PDFDict): boolean {
  const filter = dict.lookup(PDFName.of('Filter'));
  const first = filter instanceof PDFArray ? filter.lookup(0) : filter;
  if (!(first instanceof PDFName) || first.decodeText() !== 'Crypt') return false;
  const parms = dict.lookup(PDFName.of('DecodeParms'));
  const parm = parms instanceof PDFArray ? parms.lookup(0) : parms;
  const name = parm instanceof PDFDict ? parm.lookup(PDFName.of('Name')) : undefined;
  return !(name instanceof PDFName) || name.decodeText() === 'Identity';
}

async function loadEncrypted(bytes: Uint8Array, password: string | undefined): Promise<PDFDocument> {
  // Pass 1: read the trailer + /Encrypt dictionary. Object streams are
  // skipped here since their contents are still ciphertext.
  const probe = await withPatchedParser(
    () => (() => ({ parseIntoContext: async () => undefined })) as unknown as ForStream,
    () => PDFDocument.load(bytes, LOAD_OPTIONS)
  );
  const encryptRaw = probe.context.trailerInfo.Encrypt;
  const encryptDict = encryptRaw ? probe.context.lookup(encryptRaw) : undefined;
  if (!(encryptDict instanceof PDFDict)) {
    // "/Encrypt" appeared in the bytes but the document isn't actually encrypted.
    return PDFDocument.load(bytes, LOAD_OPTIONS);
  }
  const fileId = firstFileId(probe.context.lookup(probe.context.trailerInfo.ID as PDFObject));

  let handler = await createSecurityHandler(encryptDict, fileId, '');
  if (!handler && password !== undefined && password !== '') {
    handler = await createSecurityHandler(encryptDict, fileId, password);
    if (!handler) throw new PdfPasswordError('PASSWORD_INCORRECT');
  }
  if (!handler) throw new PdfPasswordError('PASSWORD_REQUIRED');
  const security = handler;

  // Pass 2: real parse, decrypting each object stream before pdf-lib reads it.
  const fromObjStm = new Set<number>();
  const doc = await withPatchedParser(
    (original, currentRef) =>
      ((rawStream: PDFRawStream, shouldWaitForTick?: () => boolean) => ({
        parseIntoContext: async () => {
          const ref = currentRef();
          let stream = rawStream;
          if (ref) {
            const plain = await security.decryptStream(rawStream.getContents(), ref.objectNumber, ref.generationNumber);
            stream = PDFRawStream.of(rawStream.dict, plain);
          }
          try {
            objectNumbersInObjStm(stream).forEach((n) => fromObjStm.add(n));
          } catch {
            // header unreadable — the parse below will report/skip as usual
          }
          return original(stream, shouldWaitForTick).parseIntoContext();
        },
      })) as unknown as ForStream,
    () => PDFDocument.load(bytes, LOAD_OPTIONS)
  );

  const context = doc.context;
  const encryptRef = context.trailerInfo.Encrypt instanceof PDFRef ? context.trailerInfo.Encrypt : null;

  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    if (encryptRef && ref === encryptRef) continue;
    if (fromObjStm.has(ref.objectNumber)) continue;
    const { objectNumber: num, generationNumber: gen } = ref;

    if (obj instanceof PDFStream) {
      const type = obj.dict.lookup(PDFName.of('Type'));
      const typeName = type instanceof PDFName ? type.decodeText() : '';
      if (typeName === 'XRef' || typeName === 'ObjStm') continue;
      await decryptValue(obj.dict, security, num, gen);
      if (typeName === 'Metadata' && !security.encryptMetadata) continue;
      if (isCryptIdentityStream(obj.dict)) continue;
      if (obj instanceof PDFRawStream) {
        const plain = await security.decryptStream(obj.getContents(), num, gen);
        context.assign(ref, PDFRawStream.of(obj.dict, plain));
      }
    } else if (obj instanceof PDFDict || obj instanceof PDFArray) {
      await decryptValue(obj, security, num, gen);
    } else if (obj instanceof PDFString || obj instanceof PDFHexString) {
      context.assign(ref, await decryptValue(obj, security, num, gen));
    }
  }

  delete context.trailerInfo.Encrypt;
  return doc;
}

const openedInfo = new WeakMap<PDFDocument, OpenedPdfInfo>();

/** Loads any PDF — plain, owner-restricted, or password-protected — as a plain, editable PDFDocument. */
export async function openPdf(input: ArrayBuffer | Uint8Array, options: OpenPdfOptions = {}): Promise<PDFDocument> {
  const bytes = toBytes(input);
  if (!containsEncryptToken(bytes)) {
    const doc = await PDFDocument.load(bytes, LOAD_OPTIONS);
    openedInfo.set(doc, { wasEncrypted: false });
    return doc;
  }
  const doc = await loadEncrypted(bytes, options.password);
  openedInfo.set(doc, { wasEncrypted: doc.isEncrypted });
  return doc;
}

export function wasEncrypted(doc: PDFDocument): boolean {
  return openedInfo.get(doc)?.wasEncrypted ?? false;
}

/** Cheap check (no parsing beyond the /Encrypt dictionary) for UI purposes. */
export async function isPdfEncrypted(input: ArrayBuffer | Uint8Array): Promise<boolean> {
  const bytes = toBytes(input);
  if (!containsEncryptToken(bytes)) return false;
  const probe = await withPatchedParser(
    () => (() => ({ parseIntoContext: async () => undefined })) as unknown as ForStream,
    () => PDFDocument.load(bytes, LOAD_OPTIONS)
  );
  return !!probe.context.trailerInfo.Encrypt;
}

/** Serializes a document to a standalone ArrayBuffer (for zero-copy transfer). */
export async function savePdf(doc: PDFDocument, options: { useObjectStreams?: boolean } = {}): Promise<ArrayBuffer> {
  const bytes = await doc.save({ useObjectStreams: options.useObjectStreams ?? true, addDefaultPage: false });
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
