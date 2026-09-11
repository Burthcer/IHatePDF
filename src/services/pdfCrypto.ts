/**
 * PDF Standard Security Handler — Revision 6 (AES-256 / AESV3, PDF 2.0)
 * IHatePDF - 100% Client-Side Architecture
 *
 * pdf-lib has no encryption support at all. This module implements the
 * ISO 32000-2 "Standard Security Handler" revision 6 crypto directly,
 * using the browser's native Web Crypto (SubtleCrypto) for every actual
 * cryptographic primitive (SHA-256/384/512, AES-256-CBC) so no hand-rolled
 * cipher/hash code exists here — only the PDF-spec-defined sequencing of
 * those calls. RC4/MD5 (used by older, weaker revisions 2-4) are
 * deliberately not implemented.
 *
 * ponytail: revision 6 only. Older RC4-based PDFs (V1-V4, e.g. from Acrobat
 * or other tools) are not decryptable by this module — Unlock reports a
 * clear "unsupported encryption" error for those rather than pretending to
 * handle them. Add RC4/R2-R4 support if real-world files need it.
 */

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 === 1 ? hex + '0' : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// TypeScript's DOM lib types Uint8Array as generic (Uint8Array<TArrayBuffer>) and
// SubtleCrypto's BufferSource as requiring a concrete ArrayBuffer-backed view; our
// arrays are always plain ArrayBuffer-backed at runtime (never SharedArrayBuffer),
// so this narrows the type without changing any runtime behavior.
function bs(data: Uint8Array): BufferSource {
  return data as unknown as BufferSource;
}

async function sha(algorithm: 'SHA-256' | 'SHA-384' | 'SHA-512', data: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest(algorithm, bs(data));
  return new Uint8Array(digest);
}

/**
 * Raw AES-CBC with NO padding, for exactly block-aligned input. SubtleCrypto
 * only exposes PKCS7-padded AES-CBC, so this uses a standard trick: encrypt
 * the (already block-aligned) plaintext, which makes SubtleCrypto append one
 * extra padding block, then drop that trailing block — CBC chaining means
 * the ciphertext of the real blocks is unaffected by what follows them.
 * With a zero IV and single-block input this is also equivalent to AES-ECB.
 */
async function aesCbcNoPadding(
  key: Uint8Array,
  iv: Uint8Array,
  data: Uint8Array,
  mode: 'encrypt' | 'decrypt'
): Promise<Uint8Array> {
  if (data.length % 16 !== 0) {
    throw new Error('aesCbcNoPadding requires block-aligned (multiple of 16 bytes) input');
  }
  const cryptoKey = await crypto.subtle.importKey('raw', bs(key), { name: 'AES-CBC' }, false, [mode]);
  if (mode === 'encrypt') {
    const full = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: bs(iv) }, cryptoKey, bs(data)));
    return full.slice(0, data.length);
  }
  // For no-padding decrypt, append a correctly-padded final block ourselves
  // (encrypt of an all-0x10 block under the same key/chain) so SubtleCrypto's
  // padding validation on the final block succeeds, then discard the block.
  const chainIv = data.length >= 16 ? data.slice(data.length - 16) : iv;
  const paddingBlock = new Uint8Array(16).fill(16);
  const fakePadCipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-CBC', iv: bs(chainIv) },
      await crypto.subtle.importKey('raw', bs(key), { name: 'AES-CBC' }, false, ['encrypt']),
      bs(paddingBlock)
    )
  );
  const withFakePad = concatBytes(data, fakePadCipher.slice(0, 16));
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-CBC', iv: bs(iv) }, cryptoKey, bs(withFakePad))
  );
  return plain;
}

async function aesCbcEncryptPadded(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey('raw', bs(key), { name: 'AES-CBC' }, false, ['encrypt']);
  return new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: bs(iv) }, cryptoKey, bs(data)));
}

async function aesCbcDecryptPadded(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey('raw', bs(key), { name: 'AES-CBC' }, false, ['decrypt']);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: bs(iv) }, cryptoKey, bs(data)));
}

/**
 * Algorithm 2.B (ISO 32000-2, 7.6.4.3.4): the "hardened hash" used to turn a
 * password + salt (+ optional extra user-key input, for owner-password
 * hashing) into a 32-byte value, for both generating and validating O/U.
 */
async function hardenedHash2B(
  password: Uint8Array,
  salt: Uint8Array,
  userKey: Uint8Array = new Uint8Array(0)
): Promise<Uint8Array> {
  let k = await sha('SHA-256', concatBytes(password, salt, userKey));

  let round = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const unit = concatBytes(password, k, userKey);
    const k1 = new Uint8Array(unit.length * 64);
    for (let i = 0; i < 64; i++) k1.set(unit, i * unit.length);

    const aesKey = k.slice(0, 16);
    const aesIv = k.slice(16, 32);
    const e = await aesCbcNoPadding(aesKey, aesIv, k1, 'encrypt');

    let sum = 0;
    for (let i = 0; i < 16; i++) sum += e[i];
    const mod = sum % 3;
    k = mod === 0 ? await sha('SHA-256', e) : mod === 1 ? await sha('SHA-384', e) : await sha('SHA-512', e);

    round++;
    if (round >= 64 && e[e.length - 1] <= round - 32) break;
  }

  return k.slice(0, 32);
}

export interface EncryptionMaterial {
  fileKey: Uint8Array; // 32 bytes — the actual key content is encrypted with
  O: Uint8Array; // 48 bytes
  U: Uint8Array; // 48 bytes
  OE: Uint8Array; // 32 bytes
  UE: Uint8Array; // 32 bytes
  Perms: Uint8Array; // 16 bytes
}

/**
 * Generates a fresh random file encryption key, and wraps it for both a
 * user (open) password and an owner (permissions) password, per Algorithms
 * 8 and 9. `permissionsP` is the 32-bit signed /P value (already computed).
 */
export async function buildEncryptionMaterial(
  userPassword: string,
  ownerPassword: string,
  permissionsP: number,
  encryptMetadata: boolean
): Promise<EncryptionMaterial> {
  const fileKey = randomBytes(32);
  const userPwBytes = new TextEncoder().encode(userPassword).slice(0, 127);
  const ownerPwBytes = new TextEncoder().encode(ownerPassword).slice(0, 127);

  // --- Algorithm 8: U / UE ---
  const uValidationSalt = randomBytes(8);
  const uKeySalt = randomBytes(8);
  const uHash = await hardenedHash2B(userPwBytes, uValidationSalt);
  const U = concatBytes(uHash, uValidationSalt, uKeySalt);
  const uIntermediateKey = await hardenedHash2B(userPwBytes, uKeySalt);
  const UE = await aesCbcNoPadding(uIntermediateKey, new Uint8Array(16), fileKey, 'encrypt');

  // --- Algorithm 9: O / OE (owner hash also mixes in the just-computed U) ---
  const oValidationSalt = randomBytes(8);
  const oKeySalt = randomBytes(8);
  const oHash = await hardenedHash2B(ownerPwBytes, oValidationSalt, U);
  const O = concatBytes(oHash, oValidationSalt, oKeySalt);
  const oIntermediateKey = await hardenedHash2B(ownerPwBytes, oKeySalt, U);
  const OE = await aesCbcNoPadding(oIntermediateKey, new Uint8Array(16), fileKey, 'encrypt');

  // --- Perms (redundant permissions integrity check; §7.6.4.3.5) ---
  const permsPlain = new Uint8Array(16);
  new DataView(permsPlain.buffer).setInt32(0, permissionsP, true);
  permsPlain.set([0xff, 0xff, 0xff, 0xff], 4);
  permsPlain[8] = encryptMetadata ? 0x54 : 0x46; // 'T' / 'F'
  permsPlain.set([0x61, 0x64, 0x62], 9); // "adb"
  permsPlain.set(randomBytes(4), 12);
  const Perms = await aesCbcNoPadding(fileKey, new Uint8Array(16), permsPlain, 'encrypt');

  return { fileKey, O, U, OE, UE, Perms };
}

export interface StandardSecurityDictValues {
  O: Uint8Array;
  U: Uint8Array;
  OE: Uint8Array;
  UE: Uint8Array;
}

/**
 * Recovers the file encryption key from a candidate password, trying it as
 * the user password first, then the owner password. Returns null if it
 * matches neither (per Algorithms "Authenticating the User/Owner Password").
 */
export async function recoverFileKey(
  password: string,
  values: StandardSecurityDictValues
): Promise<{ fileKey: Uint8Array; isOwner: boolean } | null> {
  const pwBytes = new TextEncoder().encode(password).slice(0, 127);

  const uValidationSalt = values.U.slice(32, 40);
  const uKeySalt = values.U.slice(40, 48);
  const uHashCandidate = await hardenedHash2B(pwBytes, uValidationSalt);
  if (bytesEqual(uHashCandidate, values.U.slice(0, 32))) {
    const intermediateKey = await hardenedHash2B(pwBytes, uKeySalt);
    const fileKey = await aesCbcNoPadding(intermediateKey, new Uint8Array(16), values.UE, 'decrypt');
    return { fileKey, isOwner: false };
  }

  const oValidationSalt = values.O.slice(32, 40);
  const oKeySalt = values.O.slice(40, 48);
  const oHashCandidate = await hardenedHash2B(pwBytes, oValidationSalt, values.U);
  if (bytesEqual(oHashCandidate, values.O.slice(0, 32))) {
    const intermediateKey = await hardenedHash2B(pwBytes, oKeySalt, values.U);
    const fileKey = await aesCbcNoPadding(intermediateKey, new Uint8Array(16), values.OE, 'decrypt');
    return { fileKey, isOwner: true };
  }

  return null;
}

/**
 * Encrypts one string/stream's plaintext bytes for storage (Algorithm 1.A —
 * AESV3 uses the file key directly, no per-object key derivation needed).
 * Output is a random 16-byte IV followed by standard PKCS7-padded CBC
 * ciphertext.
 */
export async function encryptBytesAESV3(fileKey: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  const iv = randomBytes(16);
  const ciphertext = await aesCbcEncryptPadded(fileKey, iv, plaintext);
  return concatBytes(iv, ciphertext);
}

export async function decryptBytesAESV3(fileKey: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  if (data.length < 16) return new Uint8Array(0);
  const iv = data.slice(0, 16);
  const ciphertext = data.slice(16);
  if (ciphertext.length === 0) return new Uint8Array(0);
  return aesCbcDecryptPadded(fileKey, iv, ciphertext);
}
