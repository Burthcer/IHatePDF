/**
 * Typed RPC Web Worker Bridge Hook
 * IHatePDF - 100% Client-Side Architecture
 *
 * Provides a type-safe RPC interface over Web Workers with:
 * - Native zero-copy ArrayBuffer transfer list support (postMessage(msg, [buffer]))
 * - Chunked progress tracking (0-100%) and stage reporting
 * - Automatic cancellation, timeout handling, and lifecycle cleanup on component unmount
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import type {
  WorkerAction,
  WorkerRequest,
  WorkerIncomingMessage,
  WorkerResponse,
} from '../types/worker';

export interface UseWorkerBridgeOptions {
  timeoutMs?: number;
}

export interface WorkerBridgeState {
  isProcessing: boolean;
  progress: number;
  stage: string;
  error: string | null;
}

export function useWorkerBridge<TResult = unknown>(
  workerFactory: () => Worker,
  options: UseWorkerBridgeOptions = {}
) {
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [progress, setProgress] = useState<number>(0);
  const [stage, setStage] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const activeRequestIdRef = useRef<string | null>(null);
  const rejectActivePromiseRef = useRef<((reason?: unknown) => void) | null>(null);

  // Initialize or retrieve worker instance
  const getOrCreateWorker = useCallback((): Worker => {
    if (!workerRef.current) {
      workerRef.current = workerFactory();
    }
    return workerRef.current;
  }, [workerFactory]);

  // Terminate active worker
  const terminateWorker = useCallback(() => {
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
    if (rejectActivePromiseRef.current) {
      rejectActivePromiseRef.current(new Error('Worker execution cancelled.'));
      rejectActivePromiseRef.current = null;
    }
    activeRequestIdRef.current = null;
    setIsProcessing(false);
    setProgress(0);
    setStage('');
  }, []);

  // Lifecycle cleanup on unmount
  useEffect(() => {
    return () => {
      terminateWorker();
    };
  }, [terminateWorker]);

  /**
   * Executes a typed worker task with optional zero-copy transferables.
   *
   * @param action WorkerAction to perform
   * @param payload Request payload data
   * @param transferables Optional list of Transferable objects (ArrayBuffers) for zero-copy transfer
   */
  const runTask = useCallback(
    <TPayload>(
      action: WorkerAction | string,
      payload: TPayload,
      transferables: Transferable[] = []
    ): Promise<TResult> => {
      return new Promise<TResult>((resolve, reject) => {
        // Cancel any pending task before running a new one
        if (activeRequestIdRef.current) {
          terminateWorker();
        }

        let worker: Worker;
        try {
          worker = getOrCreateWorker();
        } catch (factoryErr) {
          const errMessage =
            factoryErr instanceof Error ? factoryErr.message : 'Failed to initialize worker';
          setError(errMessage);
          reject(new Error(errMessage));
          return;
        }

        for (const item of transferables) {
          if (!(item instanceof ArrayBuffer)) {
            const errMessage = 'Invalid transferable: only ArrayBuffer instances may be zero-copy transferred';
            setError(errMessage);
            reject(new Error(errMessage));
            return;
          }
          if (item.byteLength === 0) {
            const errMessage = 'Invalid transferable: ArrayBuffer is already detached (byteLength is 0)';
            setError(errMessage);
            reject(new Error(errMessage));
            return;
          }
        }

        const requestId = crypto.randomUUID();
        activeRequestIdRef.current = requestId;
        rejectActivePromiseRef.current = reject;

        setIsProcessing(true);
        setProgress(0);
        setStage('Initializing worker...');
        setError(null);

        let timeoutTimer: NodeJS.Timeout | null = null;
        if (options.timeoutMs && options.timeoutMs > 0) {
          timeoutTimer = setTimeout(() => {
            terminateWorker();
            reject(new Error(`Worker task timed out after ${options.timeoutMs}ms.`));
          }, options.timeoutMs);
        }

        const handleMessage = (event: MessageEvent<WorkerIncomingMessage<TResult>>) => {
          const message = event.data;
          if (!message) return;

          if (message.type === 'PROGRESS') {
            if (message.payload.id === requestId) {
              setProgress(message.payload.progress);
              setStage(message.payload.stage);
            }
          } else if (message.type === 'RESPONSE') {
            const res: WorkerResponse<TResult> = message.payload;
            if (res.id === requestId) {
              cleanup();
              if (res.success && res.data !== undefined) {
                resolve(res.data);
              } else {
                const errMessage = res.error || 'Unknown worker execution failure';
                setError(errMessage);
                reject(new Error(errMessage));
              }
            }
          }
        };

        const handleError = (err: ErrorEvent) => {
          cleanup();
          const errMessage = err.message || 'Worker thread execution error';
          setError(errMessage);
          reject(new Error(errMessage));
        };

        const cleanup = () => {
          if (timeoutTimer) clearTimeout(timeoutTimer);
          worker.removeEventListener('message', handleMessage);
          worker.removeEventListener('error', handleError);
          activeRequestIdRef.current = null;
          rejectActivePromiseRef.current = null;
          setIsProcessing(false);
        };

        worker.addEventListener('message', handleMessage);
        worker.addEventListener('error', handleError);

        const request: WorkerRequest<TPayload> = {
          id: requestId,
          action,
          payload,
        };

        try {
          if (transferables.length > 0) {
            // Strict zero-copy buffer transfer
            worker.postMessage(request, transferables);
          } else {
            worker.postMessage(request);
          }
        } catch (postErr) {
          cleanup();
          const errMessage = postErr instanceof Error ? postErr.message : 'Failed to post message to worker';
          setError(errMessage);
          reject(new Error(errMessage));
        }
      });
    },
    [getOrCreateWorker, options.timeoutMs, terminateWorker]
  );

  return {
    runTask,
    isProcessing,
    progress,
    stage,
    error,
    cancelTask: terminateWorker,
    resetState: () => {
      setProgress(0);
      setStage('');
      setError(null);
    },
  };
}
