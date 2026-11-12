/**
 * Desktop app: the editor's PREVIEW and EXPORT from the Rust engine (crates/ihp-core/src/editpdf/apply.rs).
 * Each returns null when Rust can't do it (a browser, a password, Unicode text that needs an embedded font, ...):
 * `nativeFirst` then hands the same request to the TypeScript worker, which holds the editing session.
 */
import { hasNative, inputBytes, stageInput, type NativeHandler } from '../../services/nativeWorker';
import { MAX_NATIVE_BYTES } from '../../services/nativeTools';
import type { PdfInput } from '../../types/worker';
import type { PageEdits } from './engine/rewrite';

/** A preview re-reads the whole file in Rust each time; past this the TypeScript session (already open) is quicker. */
const PREVIEW_MAX_BYTES = 40 * 1024 * 1024;

const tauri = () => (globalThis as unknown as { __TAURI__: { core: { invoke: (c: string, a: unknown) => Promise<any> } } }).__TAURI__;

let source: PdfInput | null = null;
let hasPassword = false;

/** Remembers what the session opened, then lets the TypeScript worker open it too. */
export const openRecord: NativeHandler = async (p) => {
  source = (p.source ?? p.buffer) as PdfInput;
  hasPassword = !!p.password;
  return null;
};

/** PageEdits for Rust: added pictures become staged work-folder files. */
async function forRust(edits: PageEdits[], staged: string[]): Promise<unknown[]> {
  const out = window.ihpDesktop!.output;
  return Promise.all(
    edits.map(async (e) => ({
      ...e,
      addedImages: await Promise.all(
        e.addedImages.map(async ({ bytes, ...rest }) => {
          const handle = await out.create();
          await out.write(handle, new Uint8Array(bytes));
          const { path } = await out.close(handle);
          staged.push(path);
          return { ...rest, file: path };
        })
      ),
    }))
  );
}

async function run(edits: PageEdits[], onlyPage: number | null) {
  const staged: string[] = [];
  try {
    const path = await stageInput(source!);
    return await tauri().core.invoke('edit_apply', { path, edits: await forRust(edits, staged), onlyPage });
  } finally {
    staged.forEach((f) => void window.ihpDesktop!.output.discard(f).catch(() => undefined));
  }
}

const usable = () => hasNative() && !!source && !hasPassword && inputBytes(source) <= MAX_NATIVE_BYTES;

export const previewNative: NativeHandler = async (p) => {
  if (!usable() || inputBytes(source!) > PREVIEW_MAX_BYTES) return null;
  const edits = p.edits as PageEdits;
  const r: { path: string } = await run([edits], edits.pageIndex);
  const bytes = (await window.ihpDesktop!.output.read(r.path)) as Uint8Array;
  void window.ihpDesktop!.output.discard(r.path).catch(() => undefined);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return { buffer };
};

export const exportNative: NativeHandler = async (p, ctx) => {
  if (!usable()) return null;
  ctx.progress(10, 'Applying edits...');
  const r: { path: string; size: number; pages: number } = await run((p.edits as PageEdits[]).filter((e) => e.blocks.length + e.images.length + e.texts.length + e.addedImages.length + e.shapes.length > 0), null);
  if (ctx.signal.aborted) {
    void window.ihpDesktop!.output.discard(r.path);
    return null;
  }
  ctx.progress(100, 'Done.');
  const base = String(p.fileName || 'document').replace(/\.[^/.]+$/, '');
  return { fileName: `${base}_edited.pdf`, output: { kind: 'file', path: r.path, size: r.size }, size: r.size, pageCount: r.pages };
};
