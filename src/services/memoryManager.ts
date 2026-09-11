/**
 * Memory Management & Resource Lifecycle System
 * IHatePDF - 100% Client-Side Architecture
 *
 * Implements strict memory cleanup policies:
 * - Canvas pooling & bitmap zeroing to prevent V8 GC thrashing and mobile Safari OOM crashes.
 * - Centralized Object URL registry with automatic batch revocation.
 * - PDFDocumentProxy lifecycle destruction.
 */

import type { PDFDocumentProxy } from 'pdfjs-dist';

class MemoryManagerService {
  private activeObjectUrls: Set<string> = new Set();
  private canvasPool: HTMLCanvasElement[] = [];
  private maxPoolSize = 6;

  /**
   * Registers an Object URL (blob:) to be tracked for memory cleanup.
   */
  public registerUrl(url: string): string {
    if (url && url.startsWith('blob:')) {
      this.activeObjectUrls.add(url);
    }
    return url;
  }

  /**
   * Registers an array of Object URLs.
   */
  public registerUrls(urls: string[]): string[] {
    urls.forEach((url) => this.registerUrl(url));
    return urls;
  }

  /**
   * Revokes a specific Object URL and frees memory.
   */
  public revokeUrl(url: string): void {
    if (url && this.activeObjectUrls.has(url)) {
      try {
        URL.revokeObjectURL(url);
      } catch (err) {
        console.warn('Failed to revoke object URL:', err);
      }
      this.activeObjectUrls.delete(url);
    }
  }

  /**
   * Batch revokes all tracked Object URLs.
   */
  public revokeAllUrls(): void {
    this.activeObjectUrls.forEach((url) => {
      try {
        URL.revokeObjectURL(url);
      } catch (err) {
        console.warn('Failed to revoke object URL in bulk:', err);
      }
    });
    this.activeObjectUrls.clear();
  }

  /**
   * Acquires a recycled HTMLCanvasElement from the pool or allocates a new one.
   */
  public acquireCanvas(width: number, height: number): HTMLCanvasElement {
    let canvas = this.canvasPool.pop();
    if (!canvas) {
      canvas = document.createElement('canvas');
    }
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  /**
   * Releases and zeroes a canvas element back to the pool to reclaim GPU bitmap RAM.
   */
  public releaseCanvas(canvas: HTMLCanvasElement | null): void {
    if (!canvas) return;

    // Reset dimensions to 0 to discard the backing bitmap in WebKit/Blink
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    canvas.width = 0;
    canvas.height = 0;

    if (this.canvasPool.length < this.maxPoolSize) {
      this.canvasPool.push(canvas);
    }
  }

  /**
   * Destroys a PDFDocumentProxy instance safely.
   */
  public async destroyPdfDocument(doc: PDFDocumentProxy | null | undefined): Promise<void> {
    if (!doc) return;
    try {
      await doc.cleanup();
      if (doc.loadingTask) {
        await doc.loadingTask.destroy();
      }
    } catch (err) {
      console.warn('Error during PDFDocumentProxy destruction:', err);
    }
  }

  /**
   * Triggers a zero-network client-side file download and cleans up URL immediately.
   */
  public downloadBuffer(
    buffer: ArrayBuffer,
    fileName: string,
    mimeType = 'application/pdf'
  ): void {
    const blob = new Blob([buffer], { type: mimeType });
    const url = URL.createObjectURL(blob);
    this.registerUrl(url);

    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    // Schedule quick revocation once download dispatch has initiated
    setTimeout(() => {
      this.revokeUrl(url);
    }, 1000);
  }
}

export const memoryManager = new MemoryManagerService();
export default memoryManager;
