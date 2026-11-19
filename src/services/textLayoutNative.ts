/**
 * Desktop app: page text runs and picture boxes come from PDFium (Rust) instead of pdf.js, feeding
 * the same structure recovery (textLayout.ts). Returns null whenever PDFium can't do it (a rotated
 * page, an unreadable file, a very large file): the caller then uses pdf.js.
 */
import { analyzeLayout, type PageLayout, type PageRunsProvider, type Run, type Box } from './textLayout';
import { hasNative, stageInput } from './nativeWorker';
import { MAX_NATIVE_BYTES } from './nativeTools';

const BATCH = 16;
const invoke = (cmd: string, args: unknown): Promise<any> => (globalThis as unknown as { __TAURI__: { core: { invoke: (c: string, a: unknown) => Promise<any> } } }).__TAURI__.core.invoke(cmd, args);

interface NativePage {
  width: number;
  height: number;
  runs: Run[];
  images: [number, number, number, number][];
}

export async function analyzeDocumentLayoutNative(data: Blob | ArrayBuffer, onProgress?: (page: number, total: number) => void): Promise<PageLayout[] | null> {
  if (!hasNative()) return null;
  const size = data instanceof Blob ? data.size : data.byteLength;
  if (size > MAX_NATIVE_BYTES) return null;
  try {
    const path = await stageInput(data);
    const first: { total: number } = await invoke('pdf_info', { path, start: 0, count: 1 });
    if (!first.total) return null;
    let batchStart = -1;
    let batch: NativePage[] = [];
    const get: PageRunsProvider = async (p) => {
      const i = p - 1;
      if (i < batchStart || i >= batchStart + batch.length) {
        batchStart = i;
        batch = await invoke('pdf_runs', { path, start: i, count: BATCH });
      }
      const page = batch[i - batchStart];
      const images: Box[] = page.images.map(([x0, y0, x1, y1]) => ({ x0, y0, x1, y1 }));
      return { runs: page.runs, width: page.width, height: page.height, images };
    };
    return await analyzeLayout(first.total, get, onProgress);
  } catch (err) {
    console.warn('PDFium text extraction unavailable, using pdf.js:', err);
    return null;
  }
}
