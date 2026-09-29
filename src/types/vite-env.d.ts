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

/** Bridge exposed by electron/preload.cjs in the desktop app (undefined in browsers). */
interface IhpDesktopBridge {
  /** Called whenever a download finishes; returns an unsubscribe function. */
  onSaved(cb: (info: { name: string; path: string }) => void): () => void;
  showInFolder(path: string): void;
  /** Memory fail-safe (see src/services/memoryGuard.ts). */
  memory: {
    info(): Promise<import('../services/memoryGuard').MemoryState>;
    onChange(cb: (state: import('../services/memoryGuard').MemoryState) => void): () => void;
    ack?(): void;
  };
  /** Tool results streamed to temp files (see src/services/toolOutput.ts). */
  output: {
    create(): Promise<string>;
    write(handle: string, chunk: Uint8Array): Promise<void>;
    close(handle: string, discard?: boolean): Promise<{ path: string; size: number }>;
    /** Copies a result into Downloads/IHatePDF under `name`; resolves to the saved path. */
    save(path: string, name: string): Promise<string>;
    discard(path: string): Promise<void>;
    read(path: string): Promise<Uint8Array>;
  };
  /** "Share to phone" (electron/share.cjs, hotspot.cjs, bluetooth.cjs). */
  share: {
    /** Native picker; resolves to the chosen paths ([] if cancelled). */
    pick(kind: 'files' | 'folder'): Promise<string[]>;
    /** Paths of dropped files/folders. */
    pathsOf(files: File[]): string[];
    describe(paths: string[]): Promise<ShareItem[]>;
    start(paths: string[], minutes: number, mode: 'wifi' | 'hotspot'): Promise<ShareInfo>;
    /** Restarts the countdown; resolves to the new expiry (ms since epoch). */
    setMinutes(minutes: number): Promise<number | null>;
    stop(): Promise<void>;
    onEnded(cb: (reason: string) => void): () => void;
  };
  bluetooth: {
    /** Phones in range (a ~8 s Bluetooth scan). */
    scan(): Promise<{ radio: 'On' | 'Off'; devices: BluetoothPhone[] }>;
    /** Resolves when it's on the phone; rejects with a readable message. */
    send(deviceId: string, paths: string[]): Promise<void>;
    cancel(): Promise<void>;
    onEvent(cb: (ev: BluetoothEvent) => void): () => void;
    openSettings(): void;
  };
}
interface ShareItem {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
  count: number;
  /** Inside a folder: what couldn't be read and was left out (no permission, locked, link loop). */
  skipped: Array<{ name: string; reason: string }>;
}
interface ShareInfo {
  expiresAt: number;
  /** One download link per network adapter, the most likely one first. */
  urls: Array<{ name: string; url: string }>;
  /** Set for PC hotspot: what the phone joins first. */
  wifi: { ssid: string; password: string } | null;
}
type BluetoothPhone = { id: string; name: string; paired: boolean };
type BluetoothEvent = { type: 'zipping' } | { type: 'connecting' } | { type: 'waiting' | 'progress'; sent: number; size: number };
interface Window {
  ihpDesktop?: IhpDesktopBridge;
}
