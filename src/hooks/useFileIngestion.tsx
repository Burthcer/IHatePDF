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
import { readFileAsArrayBuffer, validatePdfHeader } from '../services/fileValidator';
import { openPdfJsDocument } from '../services/pdfWorkerSetup';
import { memoryManager } from '../services/memoryManager';
import { WorkerClient, WorkerCallError } from '../services/workerClient';
import type { PDFFile } from '../types/pdf';

export interface IngestOptions {
  /** Leave encrypted files encrypted (for tools that deal with encryption themselves). */
  keepEncrypted?: boolean;
}

interface PasswordRequest {
  fileName: string;
  error?: string;
  resolve: (password: string | null) => void;
}

async function countPages(buffer: ArrayBuffer, password?: string): Promise<number> {
  const task = openPdfJsDocument(buffer, password);
  const doc = await task.promise;
  const n = doc.numPages;
  await memoryManager.destroyPdfDocument(doc);
  return n;
}

function isPasswordError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: string }).name === 'PasswordException';
}

let decryptClient: WorkerClient | null = null;
function decryptor(): WorkerClient {
  decryptClient ??= new WorkerClient(
    () => new Worker(new URL('../features/unlock/unlock.worker.ts', import.meta.url), { type: 'module' })
  );
  return decryptClient;
}

async function decrypt(buffer: ArrayBuffer, fileName: string, password: string): Promise<ArrayBuffer> {
  const copy = buffer.slice(0);
  const res = await decryptor().call<{ buffer: ArrayBuffer }>('UNLOCK_PDF', { fileBuffer: copy, fileName, password }, [copy]);
  return res.buffer;
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
        let buffer: ArrayBuffer;
        try {
          buffer = await readFileAsArrayBuffer(file);
        } catch {
          bad.push(`${file.name} (couldn’t be read)`);
          continue;
        }
        const entry: PDFFile = {
          id: `file_${crypto.randomUUID()}`,
          name: file.name,
          size: file.size,
          pageCount: 0,
          rawBuffer: buffer,
          previewUrls: [],
        };
        try {
          entry.pageCount = await countPages(buffer);
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
              entry.pageCount = await countPages(buffer, pw);
            } catch (e) {
              if (isPasswordError(e)) {
                error = 'That password didn’t work. Try again.';
                continue;
              }
            }
            try {
              entry.rawBuffer = await decrypt(buffer, file.name, pw);
              entry.size = entry.rawBuffer.byteLength;
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

