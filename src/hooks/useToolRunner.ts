/**
 * The run → result → download cycle every single-output tool shares, on top
 * of useWorkerBridge. Spread `layout` into <ToolLayout>.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useWorkerBridge } from './useWorkerBridge';
import { discardResult, saveResult, type ResultData } from '../services/toolOutput';
import type { ToolOutput } from '../types/worker';

export interface RunnableResult {
  /** In-memory result (small outputs). */
  buffer?: ArrayBuffer;
  /** Streamed result, stored in a temp file (desktop) or Blob. */
  output?: ToolOutput;
  fileName: string;
  mimeType?: string;
}

/** The result's bytes, wherever they are. */
export const dataOf = (r: RunnableResult | null | undefined): ResultData | null => r?.output ?? r?.buffer ?? null;

export function useToolRunner<R extends RunnableResult>(workerFactory: () => Worker) {
  const bridge = useWorkerBridge<R>(workerFactory);
  const [result, setResultState] = useState<R | null>(null);
  const { runTask, resetState } = bridge;
  const current = useRef<R | null>(null);

  // Replacing or clearing a result frees its temp file.
  const setResult = useCallback((next: R | null) => {
    if (current.current && current.current !== next) discardResult(dataOf(current.current));
    current.current = next;
    setResultState(next);
  }, []);

  useEffect(() => () => discardResult(dataOf(current.current)), []);

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
    [runTask, setResult]
  );

  const reset = useCallback(() => {
    setResult(null);
    resetState();
  }, [resetState, setResult]);

  const download = useCallback(
    (fileName?: string) => {
      const data = dataOf(result);
      if (!result || !data) return;
      saveResult(data, fileName || result.fileName, result.mimeType ?? guessMime(result.fileName)).catch((err) =>
        console.error('Saving the result failed', err)
      );
    },
    [result]
  );

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
      resultData: dataOf(result),
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
