/**
 * The run → result → download cycle every single-output tool shares, on top
 * of useWorkerBridge. Spread `layout` into <ToolLayout>.
 */

import { useCallback, useState } from 'react';
import { useWorkerBridge } from './useWorkerBridge';
import { memoryManager } from '../services/memoryManager';

export interface RunnableResult {
  buffer: ArrayBuffer;
  fileName: string;
  mimeType?: string;
}

export function useToolRunner<R extends RunnableResult>(workerFactory: () => Worker) {
  const bridge = useWorkerBridge<R>(workerFactory);
  const [result, setResult] = useState<R | null>(null);
  const { runTask, resetState } = bridge;

  const run = useCallback(
    async <P>(action: string, payload: P, transfer: Transferable[] = []): Promise<R | null> => {
      setResult(null);
      try {
        const res = await runTask<P>(action, payload, transfer);
        setResult(res);
        return res;
      } catch (err) {
        console.error(`${action} failed:`, err);
        return null;
      }
    },
    [runTask]
  );

  const reset = useCallback(() => {
    setResult(null);
    resetState();
  }, [resetState]);

  const download = useCallback(() => {
    if (result) memoryManager.downloadBuffer(result.buffer, result.fileName, result.mimeType ?? guessMime(result.fileName));
  }, [result]);

  return {
    run,
    reset,
    result,
    setResult,
    download,
    isProcessing: bridge.isProcessing,
    layout: {
      isProcessing: bridge.isProcessing,
      progress: bridge.progress,
      stage: bridge.stage,
      error: bridge.error,
      resultBuffer: result?.buffer ?? null,
      resultFileName: result?.fileName,
      onDownloadResult: download,
      onReset: reset,
    },
  };
}

export function guessMime(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'pdf': return 'application/pdf';
    case 'zip': return 'application/zip';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'png': return 'image/png';
    case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'pptx': return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case 'md': return 'text/markdown';
    default: return 'application/octet-stream';
  }
}
