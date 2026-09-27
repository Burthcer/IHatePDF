/**
 * Builds deliberately awkward PDFs for testing the editor engine and tools:
 * raw content streams with kerned TJ arrays, Tc/Tw/Tz/Ts, the ' and "
 * operators, CMYK color, nested q/Q with scaling, an inline image, text
 * inside a shared form XObject, a two-column layout, a table, a rotated
 * page with an offset CropBox, an embedded subset TrueType (Type0,
 * Identity-H) font, AcroForm fields — plus RC4-128 (R3) and AES-128 (R4)
 * encrypted copies, written with an independent encryptor.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFStream,
  PDFString,
  PDFWriter,
  StandardFonts,
  degrees,
  rgb,
  type PDFObject,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { md5, rc4 } from '../src/services/legacyCrypto';

const enc = new TextEncoder();

function hex(s: string): string {
  return '<' + Array.from(s, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('') + '>';
}

export const PAGE1_TEXT = {
  heading: 'Quarterly Operations Review',
  para1: [
    'Revenue grew steadily across every region this quarter,',
    'driven mostly by renewals and a strong finish in the',
    'enterprise segment. Costs stayed flat despite hiring.',
  ],
  kerned: 'AVATAR Wave Tokyo',
  colLeft: ['Left column first line', 'Left column second line'],
  colRight: ['Right column first line', 'Right column second line'],
  table: [
    ['Region', 'Q1', 'Q2'],
    ['North', '1,204', '1,390'],
    ['South', '980', '1,105'],
  ],
  header: 'ACME Corp Confidential',
  quoteOp: 'Line drawn with the quote operator',
  dquoteOp: 'Line drawn with the double quote operator',
};

export async function buildComplexPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const helvBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const times = await doc.embedFont(StandardFonts.TimesRoman);
  const libBytes = readFileSync(resolve('node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf'));
  const lib = await doc.embedFont(libBytes, { subset: true });
  const ctx = doc.context;

  // Shared header form XObject (used on pages 1 and 2)
  const formContent = `BT /FH 9 Tf 0.5 0.5 0.5 rg 1 0 0 1 36 0 Tm ${hex(PAGE1_TEXT.header)} Tj ET`;
  const form = ctx.flateStream(enc.encode(formContent), {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: [0, -5, 400, 15],
    Resources: { Font: { FH: helv.ref } },
  });
  const formRef = ctx.register(form);

  // ---------------- Page 1: raw content with every text operator we handle
  const p1 = doc.addPage([612, 792]);
  // trigger font/resource registration via a real drawText (Times, bottom)
  p1.drawText('Footer drawn by pdf-lib', { x: 36, y: 30, size: 8, font: times });
  const res1 = p1.node.Resources()!;
  const fonts1 = res1.lookup(PDFName.of('Font'), PDFDict);
  fonts1.set(PDFName.of('F1'), helv.ref);
  fonts1.set(PDFName.of('F2'), helvBold.ref);
  const xo1 = res1.lookup(PDFName.of('XObject'), PDFDict);
  xo1.set(PDFName.of('Hdr'), formRef);

  const t = PAGE1_TEXT;
  const lines: string[] = [];
  lines.push('q 1 0 0 1 0 760 cm /Hdr Do Q'); // header via form
  lines.push(`BT /F2 20 Tf 0 0 0 1 k 1 0 0 1 72 700 Tm ${hex(t.heading)} Tj ET`);
  // justified-ish paragraph with Tw and TL/T*
  lines.push('BT /F1 11 Tf 0 g 14 TL 1 0 0 1 72 670 Tm 0.4 Tw');
  lines.push(`${hex(t.para1[0])} Tj T* ${hex(t.para1[1])} Tj T* ${hex(t.para1[2])} Tj`);
  lines.push('0 Tw ET');
  // kerned TJ array + char spacing + horizontal scaling, inside scaled q/Q
  lines.push('q 1.25 0 0 1.25 0 0 cm');
  lines.push(`BT /F1 10 Tf 0.2 0.3 0.8 rg 0.5 Tc 95 Tz 1 0 0 1 57.6 488 Tm [(AV) 80 (A) 60 (T) 120 (AR) -250 (W) 60 (ave) -250 (T) 40 (okyo)] TJ 0 Tc 100 Tz ET`);
  lines.push('Q');
  // quote operators
  lines.push(`BT /F1 11 Tf 0 g 16 TL 1 0 0 1 72 580 Tm ${hex(t.quoteOp)} ' 2 0.2 ${hex(t.dquoteOp)} " 0 Tw 0 Tc ET`);
  // superscript with Ts
  lines.push(`BT /F1 11 Tf 1 0 0 1 72 530 Tm (Area in m) Tj 5 Ts /F1 7 Tf (2) Tj 0 Ts ET`);
  // two columns
  lines.push(`BT /F1 10 Tf 1 0 0 1 72 480 Tm 13 TL ${hex(t.colLeft[0])} Tj T* ${hex(t.colLeft[1])} Tj ET`);
  lines.push(`BT /F1 10 Tf 1 0 0 1 330 480 Tm 13 TL ${hex(t.colRight[0])} Tj T* ${hex(t.colRight[1])} Tj ET`);
  // table
  t.table.forEach((row, r) => {
    row.forEach((cell, c) => {
      lines.push(`BT /${r === 0 ? 'F2' : 'F1'} 10 Tf 1 0 0 1 ${72 + c * 110} ${420 - r * 16} Tm ${hex(cell)} Tj ET`);
    });
  });
  // inline image (2x2 RGB)
  lines.push('q 40 0 0 40 480 380 cm BI /W 2 /H 2 /CS /RGB /BPC 8 ID \xff\x00\x00\x00\xff\x00\x00\x00\xff\xff\xff\x00 EI Q');
  // rotated text
  lines.push(`BT /F1 12 Tf 0 1 -1 0 560 200 Tm ${hex('Rotated sidebar note')} Tj ET`);
  // rectangle behind nothing
  lines.push('q 0.9 0.9 0.9 rg 72 300 200 30 re f Q');
  lines.push(`BT /F1 10 Tf 0 g 1 0 0 1 80 312 Tm ${hex('Text on a gray box')} Tj ET`);

  const raw = lines.join('\n');
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i) & 0xff;
  p1.node.addContentStream(ctx.register(ctx.flateStream(bytes)));

  // ---------------- Page 2: rotated 90°, offset CropBox, shared header, Unicode subset font
  const p2 = doc.addPage([842, 595]);
  p2.setRotation(degrees(90));
  p2.setCropBox(20, 20, 800, 555);
  p2.drawText('Page two is rotated ninety degrees.', { x: 60, y: 480, size: 14, font: helv });
  p2.drawText('Unicode line: Grüße, Ελληνικά, Кириллица', { x: 60, y: 450, size: 12, font: lib });
  p2.drawText('Second subset line with the same font', { x: 60, y: 430, size: 12, font: lib });
  const res2 = p2.node.Resources()!;
  const xo2 = res2.lookup(PDFName.of('XObject'), PDFDict);
  xo2.set(PDFName.of('Hdr'), formRef);
  p2.node.addContentStream(ctx.register(ctx.flateStream(enc.encode('q 1 0 0 1 0 540 cm /Hdr Do Q'))));

  // ---------------- Page 3: a form + bullet list + image
  const p3 = doc.addPage([595.28, 841.89]);
  p3.drawText('Application form', { x: 50, y: 780, size: 18, font: helvBold });
  const bullets = ['• First bullet point item', '• Second bullet point item', '• Third bullet point item'];
  bullets.forEach((b, i) => p3.drawText(b, { x: 60, y: 740 - i * 16, size: 11, font: helv }));
  const form3 = doc.getForm();
  const name = form3.createTextField('applicant.name');
  name.addToPage(p3, { x: 50, y: 600, width: 200, height: 20 });
  const agree = form3.createCheckBox('applicant.agree');
  agree.addToPage(p3, { x: 50, y: 560, width: 14, height: 14 });
  const choice = form3.createDropdown('applicant.plan');
  choice.addOptions(['Basic', 'Pro', 'Enterprise']);
  choice.addToPage(p3, { x: 50, y: 520, width: 150, height: 20 });
  // a photo-like PNG
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64');
  const img = await doc.embedPng(png);
  p3.drawImage(img, { x: 350, y: 650, width: 120, height: 120 });
  p3.drawRectangle({ x: 50, y: 400, width: 200, height: 40, color: rgb(0.95, 0.9, 0.8) });

  doc.setTitle('Complex fixture');
  return doc.save({ useObjectStreams: true });
}

// ------------------------------------------------------------ encryption

const PAD = new Uint8Array([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00,
  0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
function padPw(pw: string): Uint8Array {
  const b = enc.encode(pw).slice(0, 32);
  return cat(b, PAD.slice(0, 32 - b.length));
}
function int32le(n: number) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, n, true);
  return b;
}

async function aesCbc(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const k = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'AES-CBC' }, false, ['encrypt']);
  return cat(iv, new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, k, data as BufferSource)));
}

/** Independent Standard Security Handler encryptor (R3 RC4-128 or R4 AES-128). */
export async function encryptLegacy(plain: Uint8Array, opts: { userPassword: string; ownerPassword: string; aes: boolean }): Promise<Uint8Array> {
  const doc = await PDFDocument.load(plain, { updateMetadata: false });
  const ctx = doc.context;
  const id = crypto.getRandomValues(new Uint8Array(16));
  ctx.trailerInfo.ID = ctx.obj([PDFHexString.of(Buffer.from(id).toString('hex')), PDFHexString.of(Buffer.from(id).toString('hex'))]);
  const P = -3904; // print + copy allowed, modify disallowed
  const n = 16;

  // Algorithm 3: O
  let oh = md5(padPw(opts.ownerPassword));
  for (let i = 0; i < 50; i++) oh = md5(oh);
  const okey = oh.slice(0, n);
  let O = rc4(okey, padPw(opts.userPassword));
  for (let i = 1; i <= 19; i++) O = rc4(okey.map((b) => b ^ i), O);

  // Algorithm 2: file key
  const parts = [padPw(opts.userPassword), O, int32le(P), id];
  let kh = md5(cat(...parts));
  for (let i = 0; i < 50; i++) kh = md5(kh.slice(0, n));
  const fileKey = kh.slice(0, n);

  // Algorithm 5: U
  let U = rc4(fileKey, md5(cat(PAD, id)));
  for (let i = 1; i <= 19; i++) U = rc4(fileKey.map((b) => b ^ i), U);
  U = cat(U, new Uint8Array(16));

  const objKey = (num: number, gen: number) =>
    md5(cat(fileKey, new Uint8Array([num & 255, (num >> 8) & 255, (num >> 16) & 255, gen & 255, (gen >> 8) & 255]), opts.aes ? new Uint8Array([0x73, 0x41, 0x6c, 0x54]) : new Uint8Array(0))).slice(0, Math.min(n + 5, 16));
  const encBytes = async (bytes: Uint8Array, num: number, gen: number) => (opts.aes ? aesCbc(objKey(num, gen), bytes) : rc4(objKey(num, gen), bytes));

  const walk = async (o: PDFObject, num: number, gen: number): Promise<PDFObject> => {
    if (o instanceof PDFString || o instanceof PDFHexString) return PDFHexString.of(Buffer.from(await encBytes(o.asBytes(), num, gen)).toString('hex'));
    if (o instanceof PDFArray) {
      for (let i = 0; i < o.size(); i++) o.set(i, await walk(o.get(i), num, gen));
    } else if (o instanceof PDFDict) {
      for (const [k, v] of o.entries()) o.set(k, await walk(v, num, gen));
    }
    return o;
  };
  await doc.flush();
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (obj instanceof PDFStream) {
      await walk(obj.dict, ref.objectNumber, ref.generationNumber);
      const contents = obj instanceof PDFRawStream ? obj.getContents() : (obj as unknown as { getContents(): Uint8Array }).getContents();
      ctx.assign(ref, PDFRawStream.of(obj.dict, await encBytes(contents, ref.objectNumber, ref.generationNumber)));
    } else if (obj instanceof PDFDict || obj instanceof PDFArray) {
      await walk(obj, ref.objectNumber, ref.generationNumber);
    }
  }
  const hexStr = (b: Uint8Array) => PDFHexString.of(Buffer.from(b).toString('hex'));
  const encDict = opts.aes
    ? ctx.obj({
        Filter: 'Standard',
        V: 4,
        R: 4,
        Length: 128,
        CF: { StdCF: { CFM: 'AESV2', Length: 16, AuthEvent: 'DocOpen' } },
        StmF: 'StdCF',
        StrF: 'StdCF',
        P,
      })
    : ctx.obj({ Filter: 'Standard', V: 2, R: 3, Length: 128, P });
  (encDict as PDFDict).set(PDFName.of('O'), hexStr(O));
  (encDict as PDFDict).set(PDFName.of('U'), hexStr(U));
  (encDict as PDFDict).set(PDFName.of('P'), PDFNumber.of(P));
  ctx.trailerInfo.Encrypt = ctx.register(encDict);
  return PDFWriter.forContext(ctx, 50).serializeToBuffer();
}
