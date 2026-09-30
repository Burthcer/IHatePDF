/**
 * Page sizes for every page of a document, and thumbnails for the pages that
 * are actually on screen. Attach `thumbRef(i)` to the element showing page i:
 * its thumbnail is drawn when it scrolls into view (the first few are drawn
 * straight away). A 5,000-page file opens as fast as a 5-page one, and only
 * what's looked at is ever rendered.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { openPdfJsDocument } from '../services/pdfWorkerSetup';
import { memoryManager } from '../services/memoryManager';
import { jobsRunning, memoryState, whileOver } from '../services/memoryGuard';

export interface PageThumbInfo {
  url?: string;
  /** Displayed size in points (after /Rotate). */
  width: number;
  height: number;
  rotation: number;
}

/** Thumbnails drawn without waiting to be scrolled to. */
const EAGER = 12;
const SIZE_BATCH = 64;
const CONCURRENCY = 2;

/** `eager`: how many leading thumbnails to draw without waiting for thumbRef (0 = page sizes only). */
export function usePageThumbnails(data: Blob | ArrayBuffer | null | undefined, targetWidth = 160, eager = EAGER) {
  const [pages, setPages] = useState<PageThumbInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const wanted = useRef<number[]>([]);
  const requested = useRef(new Set<number>());
  const pump = useRef<() => void>(() => undefined);
  const observer = useRef<IntersectionObserver | null>(null);
  const indexOf = useRef(new WeakMap<Element, number>());
  const visible = useRef(new Set<number>());
  const refs = useRef(new Map<number, (el: Element | null) => void>());

  const request = useCallback((i: number) => {
    if (requested.current.has(i)) return;
    requested.current.add(i);
    wanted.current.push(i);
    pump.current();
  }, []);

  useEffect(() => {
    setPages([]);
    setError(null);
    setDone(false);
    wanted.current = [];
    requested.current = new Set();
    const size = data instanceof Blob ? data.size : data?.byteLength ?? 0;
    if (!data || size === 0) return;
    let cancelled = false;
    let doc: PDFDocumentProxy | null = null;
    const task = openPdfJsDocument(data);
    let active = 0;
    let waiting = false;
    let rendered = 0;
    let total = 0;
    let info: PageThumbInfo[] = [];

    // Finished thumbnails are applied once per frame, not once per page.
    const ready = new Map<number, string>();
    let frame = 0;
    const flush = () => {
      frame = 0;
      if (cancelled || !ready.size) return;
      const batch = new Map(ready);
      ready.clear();
      setPages((prev) => prev.map((p, k) => (batch.has(k) ? { ...p, url: batch.get(k) } : p)));
    };

    const renderOne = async (i: number) => {
      const page = await doc!.getPage(i + 1);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const vp = page.getViewport({ scale: (targetWidth * dpr) / info[i].width });
      const canvas = memoryManager.acquireCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
      const ctx = canvas.getContext('2d', { alpha: false })!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      try {
        await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
        if (cancelled) return;
        ready.set(i, canvas.toDataURL('image/jpeg', 0.75));
        frame ||= requestAnimationFrame(flush);
      } catch {
        // leave this thumbnail blank
      } finally {
        memoryManager.releaseCanvas(canvas);
        page.cleanup();
      }
    };

    pump.current = () => {
      if (!doc || cancelled) return;
      // Memory fail-safe: none while a job runs (its memory is measured) or memory is
      // over the budget, one at a time when it's tight.
      if (jobsRunning() || memoryState().level === 'over') {
        if (!waiting) {
          waiting = true;
          const retry = () => {
            if (cancelled) return;
            if (jobsRunning()) return void setTimeout(retry, 500);
            void whileOver().then(() => {
              waiting = false;
              pump.current();
            });
          };
          retry();
        }
        return;
      }
      const limit = memoryState().level === 'normal' ? CONCURRENCY : 1;
      while (active < limit && wanted.current.length) {
        const i = wanted.current.shift()!;
        if (i < 0 || i >= total) continue;
        active++;
        void renderOne(i).finally(() => {
          active--;
          rendered++;
          if (rendered >= total && !cancelled) setDone(true);
          pump.current();
        });
      }
    };

    (async () => {
      try {
        doc = await task.promise;
        total = doc.numPages;
        const sizeOf = async (i: number) => {
          const page = await doc!.getPage(i + 1);
          const vp = page.getViewport({ scale: 1 });
          return { width: vp.width, height: vp.height, rotation: page.rotate };
        };
        // The grid appears at once, every page sized like the first; real sizes
        // (which almost always match) fill in as they're read.
        const first = await sizeOf(0);
        if (cancelled) return;
        info = Array.from({ length: total }, () => ({ ...first }));
        setPages(info.map((p) => ({ ...p })));
        for (let i = 0; i < Math.min(eager, total); i++) request(i);
        visible.current.forEach((i) => request(i));
        pump.current();
        for (let start = 1; start < total; start += SIZE_BATCH) {
          const batch = await Promise.all(Array.from({ length: Math.min(SIZE_BATCH, total - start) }, (_, k) => sizeOf(start + k)));
          if (cancelled) return;
          const changed = new Map<number, PageThumbInfo>();
          batch.forEach((p, k) => {
            const i = start + k;
            if (p.width !== info[i].width || p.height !== info[i].height || p.rotation !== info[i].rotation) changed.set(i, p);
            info[i] = p;
          });
          if (changed.size) setPages((prev) => prev.map((p, i) => (changed.has(i) ? { ...changed.get(i)!, url: p.url } : p)));
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
      if (frame) cancelAnimationFrame(frame);
      pump.current = () => undefined;
      void (doc ? memoryManager.destroyPdfDocument(doc) : task.destroy());
    };
  }, [data, targetWidth, eager, request]);

  // Created on first use: refs are attached before effects run.
  const getObserver = useCallback(() => {
    if (!observer.current && typeof IntersectionObserver !== 'undefined') {
      observer.current = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            const i = indexOf.current.get(e.target);
            if (i === undefined) continue;
            if (e.isIntersecting) {
              visible.current.add(i);
              request(i);
            } else {
              visible.current.delete(i);
            }
          }
        },
        { rootMargin: '600px 0px' }
      );
    }
    return observer.current;
  }, [request]);

  useEffect(
    () => () => {
      observer.current?.disconnect();
      observer.current = null;
    },
    []
  );

  /** Ref for the element showing page `index` (0-based); its thumbnail is drawn once it's near the viewport. */
  const thumbRef = useCallback(
    (index: number) => {
      let ref = refs.current.get(index);
      if (!ref) {
        let current: Element | null = null;
        ref = (el: Element | null) => {
          if (current) {
            observer.current?.unobserve(current);
            visible.current.delete(index);
          }
          current = el;
          if (!el) return;
          indexOf.current.set(el, index);
          const io = getObserver();
          if (io) io.observe(el);
          else request(index);
        };
        refs.current.set(index, ref);
      }
      return ref;
    },
    [request, getObserver]
  );

  return { pages, error, done, thumbRef, request };
}
