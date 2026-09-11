/**
 * pdf-lib object-graph encryption/decryption
 * IHatePDF - 100% Client-Side Architecture
 *
 * pdf-lib has no concept of encryption: it can neither write an /Encrypt
 * dictionary nor decrypt ciphertext strings/streams. This module walks a
 * loaded/built PDFDocument's low-level object graph directly (PDFContext)
 * and encrypts or decrypts every string and stream in place using the
 * Standard Security Handler R6 (AESV3) primitives from `pdfCrypto.ts`, then
 * writes (or reads) the /Encrypt trailer dictionary by hand.
 *
 * Scope: documents are always saved with `useObjectStreams: false` by the
 * callers of this module (see protect/unlock workers), so pdf-lib never
 * produces compressed object/xref streams here — the "object streams and
 * cross-reference streams are never encrypted" exemption from the PDF spec
 * therefore only needs to be handled defensively (for third-party source
 * files being unlocked), not for anything this module itself produces.
 */

import {
  PDFArray,
  PDFBool,
  PDFContext,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  PDFWriter,
} from 'pdf-lib';
import {
  buildEncryptionMaterial,
  bytesToHex,
  decryptBytesAESV3,
  encryptBytesAESV3,
  recoverFileKey,
  type StandardSecurityDictValues,
} from './pdfCrypto';

export interface PermissionFlags {
  printing: boolean;
  modifying: boolean;
  copying: boolean;
  annotating: boolean;
}

const FULL_PERMISSIONS: PermissionFlags = {
  printing: true,
  modifying: true,
  copying: true,
  annotating: true,
};

/** Builds the 32-bit signed /P permissions value per PDF spec Table 22 (bits 1-indexed). */
export function computePermissionsP(perms: PermissionFlags = FULL_PERMISSIONS): number {
  let p = -4; // all bits set except bit1/bit2 (reserved; must be 0)
  if (!perms.printing) p &= ~((1 << 2) | (1 << 11)); // bit3 print, bit12 high-quality print
  if (!perms.modifying) p &= ~((1 << 3) | (1 << 10)); // bit4 modify, bit11 assemble document
  if (!perms.copying) p &= ~((1 << 4) | (1 << 9)); // bit5 copy, bit10 accessibility extraction
  if (!perms.annotating) p &= ~((1 << 5) | (1 << 8)); // bit6 annotate, bit9 fill forms
  return p | 0;
}

type ByteTransform = (bytes: Uint8Array) => Promise<Uint8Array>;

async function transformValue(value: PDFObject, transform: ByteTransform): Promise<PDFObject> {
  if (value instanceof PDFString || value instanceof PDFHexString) {
    try {
      const transformed = await transform(value.asBytes());
      return PDFHexString.of(bytesToHex(transformed));
    } catch (err) {
      // pdf-lib's PDFDocument constructor re-stamps /Producer and /ModDate on
      // every load() call — including reloading an already-encrypted file for
      // Unlock — so by the time this walk runs, those two fields are already
      // fresh plaintext, not the on-disk ciphertext. Decrypting them then
      // fails (invalid padding); leaving that one value untouched is the
      // correct behavior rather than aborting the whole document.
      console.warn('Skipping a string that could not be transformed (likely already plaintext):', err);
      return value;
    }
  }
  if (value instanceof PDFArray) {
    for (let i = 0; i < value.size(); i++) {
      const child = value.get(i);
      const replaced = await transformValue(child, transform);
      if (replaced !== child) value.set(i, replaced);
    }
    return value;
  }
  if (value instanceof PDFDict) {
    for (const [key, child] of value.entries()) {
      const replaced = await transformValue(child, transform);
      if (replaced !== child) value.set(key, replaced);
    }
    return value;
  }
  return value;
}

function resolveEncryptRef(context: PDFContext): PDFRef | null {
  const raw = context.trailerInfo.Encrypt;
  return raw instanceof PDFRef ? raw : null;
}

function isNeverEncryptedStream(dict: PDFDict): boolean {
  const type = dict.lookupMaybe(PDFName.of('Type'), PDFName);
  return type === PDFName.of('ObjStm') || type === PDFName.of('XRef');
}

/** Walks every indirect object in the document, transforming string/stream bytes in place. */
async function walkAndTransform(context: PDFContext, transform: ByteTransform): Promise<void> {
  const encryptRef = resolveEncryptRef(context);

  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    if (encryptRef && ref === encryptRef) continue;

    if (obj instanceof PDFStream) {
      if (isNeverEncryptedStream(obj.dict)) continue;
      await transformValue(obj.dict, transform);
      const transformedContents = await transform(obj.getContents());
      context.assign(ref, PDFRawStream.of(obj.dict, transformedContents));
    } else if (obj instanceof PDFDict || obj instanceof PDFArray) {
      await transformValue(obj, transform);
    }
  }
}

function buildStandardSecurityDict(
  context: PDFContext,
  material: { O: Uint8Array; U: Uint8Array; OE: Uint8Array; UE: Uint8Array; Perms: Uint8Array },
  permissionsP: number,
  encryptMetadata: boolean
): PDFDict {
  const stdCF = PDFDict.withContext(context);
  stdCF.set(PDFName.of('CFM'), PDFName.of('AESV3'));
  stdCF.set(PDFName.of('AuthEvent'), PDFName.of('DocOpen'));
  stdCF.set(PDFName.of('Length'), PDFNumber.of(32));

  const cf = PDFDict.withContext(context);
  cf.set(PDFName.of('StdCF'), stdCF);

  const dict = PDFDict.withContext(context);
  dict.set(PDFName.of('Filter'), PDFName.of('Standard'));
  dict.set(PDFName.of('V'), PDFNumber.of(5));
  dict.set(PDFName.of('R'), PDFNumber.of(6));
  dict.set(PDFName.of('Length'), PDFNumber.of(256));
  dict.set(PDFName.of('CF'), cf);
  dict.set(PDFName.of('StmF'), PDFName.of('StdCF'));
  dict.set(PDFName.of('StrF'), PDFName.of('StdCF'));
  dict.set(PDFName.of('O'), PDFHexString.of(bytesToHex(material.O)));
  dict.set(PDFName.of('U'), PDFHexString.of(bytesToHex(material.U)));
  dict.set(PDFName.of('OE'), PDFHexString.of(bytesToHex(material.OE)));
  dict.set(PDFName.of('UE'), PDFHexString.of(bytesToHex(material.UE)));
  dict.set(PDFName.of('P'), PDFNumber.of(permissionsP));
  dict.set(PDFName.of('Perms'), PDFHexString.of(bytesToHex(material.Perms)));
  dict.set(PDFName.of('EncryptMetadata'), encryptMetadata ? PDFBool.True : PDFBool.False);
  return dict;
}

export interface EncryptDocumentOptions {
  userPassword: string;
  ownerPassword: string;
  permissions?: PermissionFlags;
}

/**
 * Encrypts every string/stream in `pdfDoc` in place (AES-256 / R6) and sets
 * the trailer's /Encrypt dictionary. Caller is responsible for serializing
 * afterward via `serializeWithoutObjectStreams` (never `pdfDoc.save()`,
 * which would re-flush and could register new, unencrypted objects).
 */
export async function encryptPdfDocument(
  pdfDoc: PDFDocument,
  options: EncryptDocumentOptions
): Promise<void> {
  const permissionsP = computePermissionsP(options.permissions);
  const material = await buildEncryptionMaterial(
    options.userPassword,
    options.ownerPassword || options.userPassword,
    permissionsP,
    true
  );

  await walkAndTransform(pdfDoc.context, (bytes) => encryptBytesAESV3(material.fileKey, bytes));

  const encryptDict = buildStandardSecurityDict(pdfDoc.context, material, permissionsP, true);
  pdfDoc.context.trailerInfo.Encrypt = encryptDict;
}

export interface DecryptResult {
  success: boolean;
  isOwnerPassword?: boolean;
  error?: string;
}

/**
 * Attempts to decrypt `pdfDoc` (previously loaded with `ignoreEncryption:
 * true`) using `password`, removing the /Encrypt entry on success.
 */
export async function decryptPdfDocument(pdfDoc: PDFDocument, password: string): Promise<DecryptResult> {
  const context = pdfDoc.context;
  const encryptDict = context.lookupMaybe(context.trailerInfo.Encrypt, PDFDict);
  if (!encryptDict) {
    return { success: false, error: 'This PDF is not encrypted.' };
  }

  const filter = encryptDict.lookupMaybe(PDFName.of('Filter'), PDFName);
  const v = encryptDict.lookupMaybe(PDFName.of('V'), PDFNumber)?.asNumber();
  const r = encryptDict.lookupMaybe(PDFName.of('R'), PDFNumber)?.asNumber();
  if (filter !== PDFName.of('Standard') || v !== 5 || r !== 6) {
    return {
      success: false,
      error:
        'This PDF uses an encryption scheme not supported by IHatePDF (only AES-256 / revision 6, ' +
        'the scheme IHatePDF\'s own Protect tool produces, is currently supported).',
    };
  }

  const values: StandardSecurityDictValues = {
    O: encryptDict.lookup(PDFName.of('O'), PDFString, PDFHexString).asBytes(),
    U: encryptDict.lookup(PDFName.of('U'), PDFString, PDFHexString).asBytes(),
    OE: encryptDict.lookup(PDFName.of('OE'), PDFString, PDFHexString).asBytes(),
    UE: encryptDict.lookup(PDFName.of('UE'), PDFString, PDFHexString).asBytes(),
  };

  const recovered = await recoverFileKey(password, values);
  if (!recovered) {
    return { success: false, error: 'Incorrect password.' };
  }

  await walkAndTransform(context, (bytes) => decryptBytesAESV3(recovered.fileKey, bytes));

  delete context.trailerInfo.Encrypt;

  return { success: true, isOwnerPassword: recovered.isOwner };
}

/**
 * Serializes a document using the classic (non-object-stream) writer,
 * without going through `pdfDoc.save()` — save() re-runs `flush()`, which
 * could register new unencrypted objects after an encryption pass already
 * completed. Callers must call `await pdfDoc.flush()` themselves first,
 * before doing any encryption/decryption walk.
 */
export async function serializeWithoutObjectStreams(pdfDoc: PDFDocument): Promise<Uint8Array> {
  return PDFWriter.forContext(pdfDoc.context, 50).serializeToBuffer();
}
