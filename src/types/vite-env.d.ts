/// <reference types="vite/client" />

declare module '*?worker' {
  const workerConstructor: {
    new (options?: WorkerOptions): Worker;
  };
  export default workerConstructor;
}

declare module '*?url' {
  const url: string;
  export default url;
}

declare module 'pdfjs-dist/legacy/image_decoders/pdf.image_decoders.mjs' {
  export class JpegImage {
    constructor(options?: { colorTransform?: number; decodeTransform?: Int32Array | null });
    width: number;
    height: number;
    numComponents: number;
    parse(data: Uint8Array): void;
    getData(opts: { width: number; height: number; forceRGB?: boolean; forceRGBA?: boolean; isSourcePDF?: boolean }): Uint8ClampedArray;
  }
  export class JpxImage {
    static setOptions(opts: Record<string, unknown>): void;
    static get instance(): { decode(bytes: Uint8Array, opts?: Record<string, unknown>): Promise<Uint8ClampedArray> };
  }
}
