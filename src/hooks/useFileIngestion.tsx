/**
 * Turns dropped/picked files into PDFFile objects:
 *  - checks the %PDF header,
 *  - counts pages with pdf.js,
 *  - asks for the password of protected PDFs and decrypts them on the spot,
 *    so every tool downstream gets a plain document.
 */

import React, { useCallback, useRef, useState } from 'react';
import { Lock } from 'lucide-react';
import { Button, Field, Modal, Notice } from '../components/ui';
import { validatePdfHeader } from '../services/fileValidator';
import { memoryManager } from '../services/memoryManager';
import { WorkerClient, WorkerCallError } from '../services/workerClient';
import type { PDFFile } from '../types/pdf';
import type { ProcessedPdfResult } from '../types/worker';

export interface IngestOptions {
  /** Leave encrypted files encrypted (for tools that deal with encryption themselves). */
  keepEncrypted?: boolean;
}

interface PasswordRequest {
  fileName: string;
  error?: string;
  resolve: (password: string | null) => void;
}

const COUNT_TIMEOUT_MS = 30_000;

async function countPages(data: Blob, password?: string): Promise<number> {
  // pdf.js is loaded on first use so the home screen starts without it.
  const { openPdfJsDocument } = await import('../services/pdfWorkerSetup');
  const task = openPdfJsDocument(data, password);
  let timer = 0;
  try {
    // A badly damaged file can take pdf.js very long to read; the tools (Repair included) don't need the count.
    const tooSlow = new Promise<never>((_, reject) => (timer = window.setTimeout(() => reject(new Error('Invalid PDF structure: counting pages took too long.')), COUNT_TIMEOUT_MS)));
    const doc = await Promise.race([task.promise, tooSlow]);
    const n = doc.numPages;
    await memoryManager.destroyPdfDocument(doc);
    return n;
  } catch (err) {
    void task.destroy();
    throw err;
  } finally {
    window.clearTimeout(timer);
  }
}

function isPasswordError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: string }).name === 'PasswordException';
}

let decryptClient: WorkerClient | null = null;
function decryptor(): WorkerClient {
  // The decrypted copy is what every tool then reads, so it's kept as a Blob.
  decryptClient ??= new WorkerClient(
    () => new Worker(new URL('../features/unlock/unlock.worker.ts', import.meta.url), { type: 'module' }),
    true
  );
  return decryptClient;
}

async function decrypt(data: Blob, fileName: string, password: string): Promise<Blob> {
  const res = await decryptor().call<ProcessedPdfResult>('UNLOCK_PDF', { fileBuffer: data, fileName, password });
  if (res.output?.kind === 'blob') return res.output.blob;
  if (res.buffer) return new Blob([res.buffer], { type: 'application/pdf' });
  throw new Error('The decrypted copy could not be stored.');
}

export function useFileIngestion(options: IngestOptions = {}) {
  const [busy, setBusy] = useState(false);
  const [rejected, setRejected] = useState<string[]>([]);
  const [passwordReq, setPasswordReq] = useState<PasswordRequest | null>(null);
  const [password, setPassword] = useState('');
  const keepEncrypted = useRef(options.keepEncrypted);
  keepEncrypted.current = options.keepEncrypted;

  const askPassword = (fileName: string, error?: string) =>
    new Promise<string | null>((resolve) => {
      setPassword('');
      setPasswordReq({ fileName, error, resolve });
    });

  const ingest = useCallback(async (list: FileList | File[]): Promise<PDFFile[]> => {
    const files = Array.from(list);
    if (files.length === 0) return [];
    setBusy(true);
    setRejected([]);
    const accepted: PDFFile[] = [];
    const bad: string[] = [];
    try {
      for (const file of files) {
        if (!(await validatePdfHeader(file))) {
          bad.push(`${file.name} (not a PDF)`);
          continue;
        }
        // The File stays a handle to the file on disk; nothing is read into memory here.
        const data: Blob = file;
        const entry: PDFFile = {
          id: `file_${crypto.randomUUID()}`,
          name: file.name,
          size: file.size,
          pageCount: 0,
          data,
          previewUrls: [],
        };
        try {
          entry.pageCount = await countPages(data);
        } catch (err) {
          if (!isPasswordError(err)) {
            // pdf.js couldn't parse it; let the tool try (Repair may recover it).
            accepted.push(entry);
            continue;
          }
          if (keepEncrypted.current) {
            entry.encrypted = true;
            accepted.push(entry);
            continue;
          }
          let error: string | undefined;
          let unlocked = false;
          for (;;) {
            const pw = await askPassword(file.name, error);
            if (pw === null) break;
            try {
              entry.pageCount = await countPages(data, pw);
            } catch (e) {
              if (isPasswordError(e)) {
                error = 'That password didn’t work. Try again.';
                continue;
              }
            }
            try {
              entry.data = await decrypt(data, file.name, pw);
              entry.size = entry.data.size;
              entry.wasProtected = true;
              unlocked = true;
            } catch (e) {
              error = e instanceof WorkerCallError && e.code === 'PASSWORD_INCORRECT' ? 'That password didn’t work. Try again.' : e instanceof Error ? e.message : String(e);
              if (e instanceof WorkerCallError && e.code === 'PASSWORD_INCORRECT') continue;
              bad.push(`${file.name} (${error})`);
            }
            break;
          }
          if (unlocked) accepted.push(entry);
          else if (!bad.some((b) => b.startsWith(file.name))) bad.push(`${file.name} (password needed)`);
          continue;
        }
        accepted.push(entry);
      }
    } finally {
      setBusy(false);
      setRejected(bad);
    }
    return accepted;
  }, []);

  const close = (value: string | null) => {
    passwordReq?.resolve(value);
    setPasswordReq(null);
  };

  const dialogs = (
    <Modal
      open={!!passwordReq}
      onClose={() => close(null)}
      title={
        <span className="inline-flex items-center gap-2">
          <Lock className="w-4 h-4" /> Password required
        </span>
      }
      footer={
        <>
          <Button variant="ghost" onClick={() => close(null)}>
            Skip file
          </Button>
          <Button variant="primary" onClick={() => close(password)} disabled={!password}>
            Unlock
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (password) close(password);
        }}
        className="space-y-3"
      >
        <p className="text-sm text-muted">
          <span className="text-ink font-medium break-all">{passwordReq?.fileName}</span> is protected. Enter its password
          to open it — it’s only used here, to decrypt the file in this tab.
        </p>
        <Field label="Password">
          <input type="password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
        </Field>
        {passwordReq?.error && <Notice tone="error">{passwordReq.error}</Notice>}
      </form>
    </Modal>
  );

  return { ingest, busy, rejected, clearRejected: () => setRejected([]), dialogs };
}

export function RejectedFilesNotice({ rejected, onDismiss }: { rejected: string[]; onDismiss?: () => void }) {
  if (rejected.length === 0) return null;
  return (
    <div onClick={onDismiss}>
      <Notice tone="warn" title={rejected.length === 1 ? 'One file was skipped' : `${rejected.length} files were skipped`}>
        {rejected.join(', ')}
      </Notice>
    </div>
  );
}

