/**
 * PDF Standard Security Handler — reading side, all revisions (2-6).
 *
 * Given a document's /Encrypt dictionary, its first file ID and a candidate
 * password, `createSecurityHandler` authenticates the password (as user
 * password first, then owner password) and returns per-object string/stream
 * decryptors. Revision 6 reuses the AES-256 code in pdfCrypto.ts; revisions
 * 2-4 (RC4 40/128-bit and AES-128) use legacyCrypto.ts.
 */

import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFString, PDFBool } from 'pdf-lib';
import { md5, rc4 } from './legacyCrypto';
import { aesCbcDecryptPadded, aesCbcNoPadding, recoverFileKey } from './pdfCrypto';

const PASSWORD_PADDING = new Uint8Array([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00,
  0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

type CryptMethod = 'None' | 'V2' | 'AESV2' | 'AESV3';

export interface SecurityHandler {
  revision: number;
  encryptMetadata: boolean;
  isOwner: boolean;
  decryptString(bytes: Uint8Array, objNum: number, gen: number): Promise<Uint8Array>;
  decryptStream(bytes: Uint8Array, objNum: number, gen: number): Promise<Uint8Array>;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function bytesOf(dict: PDFDict, key: string): Uint8Array {
  const v = dict.lookup(PDFName.of(key));
  if (v instanceof PDFString || v instanceof PDFHexString) return v.asBytes();
  return new Uint8Array(0);
}

function numberOf(dict: PDFDict, key: string, fallback: number): number {
  const v = dict.lookup(PDFName.of(key));
  return v instanceof PDFNumber ? v.asNumber() : fallback;
}

/** Latin-1-ish password bytes for the legacy revisions (they predate UTF-8). */
function legacyPasswordBytes(password: string): Uint8Array {
  const out: number[] = [];
  for (const ch of password) {
    const c = ch.codePointAt(0)!;
    out.push(c < 256 ? c : 0x3f);
    if (out.length === 32) break;
  }
  return new Uint8Array(out);
}

function padPassword(pw: Uint8Array): Uint8Array {
  const out = new Uint8Array(32);
  const n = Math.min(32, pw.length);
  out.set(pw.subarray(0, n));
  out.set(PASSWORD_PADDING.subarray(0, 32 - n), n);
  return out;
}

function int32le(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, n | 0, true);
  return out;
}

/** Algorithm 2: file key from a (padded) user password. */
function computeLegacyFileKey(
  paddedPw: Uint8Array,
  O: Uint8Array,
  P: number,
  id: Uint8Array,
  revision: number,
  keyLen: number,
  encryptMetadata: boolean
): Uint8Array {
  const parts = [paddedPw, O.subarray(0, 32), int32le(P), id];
  if (revision >= 4 && !encryptMetadata) parts.push(new Uint8Array([0xff, 0xff, 0xff, 0xff]));
  let hash = md5(concat(...parts));
  if (revision >= 3) {
    for (let i = 0; i < 50; i++) hash = md5(hash.subarray(0, keyLen));
  }
  return hash.slice(0, keyLen);
}

/** Algorithms 4/5 → 6: does `key` validate against /U? */
function checkLegacyUserKey(key: Uint8Array, U: Uint8Array, id: Uint8Array, revision: number): boolean {
  if (revision === 2) {
    const expected = rc4(key, PASSWORD_PADDING);
    for (let i = 0; i < 32; i++) if (expected[i] !== U[i]) return false;
    return true;
  }
  let x: Uint8Array = rc4(key, md5(concat(PASSWORD_PADDING, id)));
  for (let i = 1; i <= 19; i++) {
    const k = key.map((b) => b ^ i);
    x = rc4(k, x);
  }
  for (let i = 0; i < 16; i++) if (x[i] !== U[i]) return false;
  return true;
}

/** Algorithm 7: recover the padded user password from an owner password. */
function userPasswordFromOwner(ownerPw: Uint8Array, O: Uint8Array, revision: number, keyLen: number): Uint8Array {
  let hash = md5(padPassword(ownerPw));
  if (revision >= 3) for (let i = 0; i < 50; i++) hash = md5(hash);
  const key = hash.slice(0, revision === 2 ? 5 : keyLen);
  if (revision === 2) return rc4(key, O.subarray(0, 32));
  let x: Uint8Array = O.slice(0, 32);
  for (let i = 19; i >= 0; i--) {
    x = rc4(key.map((b) => b ^ i), x);
  }
  return x;
}

function resolveCryptMethod(encrypt: PDFDict, filterKey: 'StmF' | 'StrF', v: number): CryptMethod {
  if (v < 4) return 'V2';
  const name = encrypt.lookup(PDFName.of(filterKey));
  const filterName = name instanceof PDFName ? name.decodeText() : 'Identity';
  if (filterName === 'Identity') return 'None';
  const cf = encrypt.lookup(PDFName.of('CF'));
  if (!(cf instanceof PDFDict)) return v === 5 ? 'AESV3' : 'V2';
  const entry = cf.lookup(PDFName.of(filterName));
  if (!(entry instanceof PDFDict)) return v === 5 ? 'AESV3' : 'V2';
  const cfm = entry.lookup(PDFName.of('CFM'));
  const method = cfm instanceof PDFName ? cfm.decodeText() : 'None';
  if (method === 'V2' || method === 'AESV2' || method === 'AESV3') return method;
  return 'None';
}

async function aesDecrypt(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  if (data.length < 32) return new Uint8Array(0);
  const iv = data.subarray(0, 16);
  const body = data.subarray(16, 16 + Math.floor((data.length - 16) / 16) * 16);
  try {
    return await aesCbcDecryptPadded(key, iv, body);
  } catch {
    // Some writers emit bad padding; fall back to a raw decrypt and a lenient unpad.
    const raw = await aesCbcNoPadding(key, iv, body, 'decrypt');
    const pad = raw[raw.length - 1];
    return pad > 0 && pad <= 16 ? raw.slice(0, raw.length - pad) : raw;
  }
}

export async function createSecurityHandler(
  encrypt: PDFDict,
  fileId: Uint8Array,
  password: string
): Promise<SecurityHandler | null> {
  const filter = encrypt.lookup(PDFName.of('Filter'));
  if (filter instanceof PDFName && filter.decodeText() !== 'Standard') {
    throw new Error(
      `This PDF uses the "${filter.decodeText()}" security handler (certificate-based encryption), which can only be opened with the matching certificate.`
    );
  }

  const v = numberOf(encrypt, 'V', 0);
  const revision = numberOf(encrypt, 'R', 2);
  const P = numberOf(encrypt, 'P', -4);
  const emObj = encrypt.lookup(PDFName.of('EncryptMetadata'));
  const encryptMetadata = !(emObj instanceof PDFBool) || emObj.asBoolean();
  const O = bytesOf(encrypt, 'O');
  const U = bytesOf(encrypt, 'U');

  const stmMethod = resolveCryptMethod(encrypt, 'StmF', v);
  const strMethod = resolveCryptMethod(encrypt, 'StrF', v);

  let fileKey: Uint8Array | null = null;
  let isOwner = false;

  if (revision >= 5) {
    const recovered = await recoverFileKey(
      password,
      {
        O: O.slice(0, 48),
        U: U.slice(0, 48),
        OE: bytesOf(encrypt, 'OE').slice(0, 32),
        UE: bytesOf(encrypt, 'UE').slice(0, 32),
      },
      revision
    );
    if (!recovered) return null;
    fileKey = recovered.fileKey;
    isOwner = recovered.isOwner;
  } else {
    let keyLen = revision === 2 ? 5 : Math.floor(numberOf(encrypt, 'Length', 40) / 8);
    if (v >= 4 && (stmMethod === 'AESV2' || strMethod === 'AESV2')) keyLen = 16;
    if (keyLen < 5 || keyLen > 16) keyLen = 16;
    const pw = legacyPasswordBytes(password);

    const asUser = computeLegacyFileKey(padPassword(pw), O, P, fileId, revision, keyLen, encryptMetadata);
    if (checkLegacyUserKey(asUser, U, fileId, revision)) {
      fileKey = asUser;
    } else {
      const userPw = userPasswordFromOwner(pw, O, revision, keyLen);
      const asOwner = computeLegacyFileKey(userPw, O, P, fileId, revision, keyLen, encryptMetadata);
      if (checkLegacyUserKey(asOwner, U, fileId, revision)) {
        fileKey = asOwner;
        isOwner = true;
      }
    }
    if (!fileKey) return null;
  }

  const key = fileKey;
  const objectKey = (objNum: number, gen: number, aes: boolean): Uint8Array => {
    const salt = aes ? [0x73, 0x41, 0x6c, 0x54] : [];
    const input = concat(
      key,
      new Uint8Array([objNum & 255, (objNum >> 8) & 255, (objNum >> 16) & 255, gen & 255, (gen >> 8) & 255, ...salt])
    );
    return md5(input).slice(0, Math.min(key.length + 5, 16));
  };

  const run = async (method: CryptMethod, bytes: Uint8Array, objNum: number, gen: number) => {
    switch (method) {
      case 'None':
        return bytes;
      case 'V2':
        return rc4(objectKey(objNum, gen, false), bytes);
      case 'AESV2':
        return aesDecrypt(objectKey(objNum, gen, true), bytes);
      case 'AESV3':
        return aesDecrypt(key, bytes);
    }
  };

  return {
    revision,
    encryptMetadata,
    isOwner,
    decryptString: (bytes, objNum, gen) => run(strMethod, bytes, objNum, gen),
    decryptStream: (bytes, objNum, gen) => run(stmMethod, bytes, objNum, gen),
  };
}

/** First element of the trailer /ID array, or empty. */
export function firstFileId(idObj: unknown): Uint8Array {
  if (idObj instanceof PDFArray && idObj.size() > 0) {
    const first = idObj.get(0);
    if (first instanceof PDFString || first instanceof PDFHexString) return first.asBytes();
  }
  return new Uint8Array(0);
}
