import React, { useState } from 'react';
import { Dropzone } from '../../components/common/Dropzone';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { Field, Notice, Panel } from '../../components/ui';
import { useToolRunner } from '../../hooks/useToolRunner';
import { getTool } from '../../constants/tools';
import type { PDFFile } from '../../types/pdf';
import type { ProcessedPdfResult, UnlockPayload } from '../../types/worker';

interface UnlockViewProps {
  initialFiles?: PDFFile[];
  onBack: () => void;
}

export const UnlockView: React.FC<UnlockViewProps> = ({ initialFiles = [], onBack }) => {
  const [files, setFiles] = useState<PDFFile[]>(initialFiles.slice(0, 1));
  const [password, setPassword] = useState('');
  const runner = useToolRunner<ProcessedPdfResult & { wasEncrypted?: boolean }>(
    () => new Worker(new URL('./unlock.worker.ts', import.meta.url), { type: 'module' })
  );
  const file = files[0];
  const needsPassword = !!file?.encrypted;

  const execute = () => {
    const buffer = file.rawBuffer.slice(0);
    const payload: UnlockPayload = { fileBuffer: buffer, fileName: file.name, password: password || undefined };
    void runner.run('UNLOCK_PDF', payload, [buffer]);
  };

  const result = runner.result;

  return (
    <ToolLayout
      tool={getTool('unlock')}
      files={files}
      onBack={onBack}
      onClearFiles={() => setFiles([])}
      onRemoveFile={() => setFiles([])}
      {...runner.layout}
      resultNote={
        result &&
        (file.wasProtected
          ? 'The password was removed when you opened the file; this copy has no protection.'
          : result.wasEncrypted
            ? 'Encryption and all restrictions removed.'
            : 'This file wasn’t encrypted — nothing needed removing.')
      }
      actionButtonLabel="Remove protection"
      onExecuteAction={execute}
      canExecute={!needsPassword || password.length > 0}
      options={
        needsPassword ? (
          <Field label="Password" hint="The password you use to open this file.">
            <input
              type="password"
              className="input"
              value={password}
              autoFocus
              onChange={(e) => {
                setPassword(e.target.value);
                runner.reset();
              }}
              onKeyDown={(e) => e.key === 'Enter' && password && execute()}
            />
          </Field>
        ) : undefined
      }
      emptyState={<Dropzone multiple={false} keepEncrypted onFilesAccepted={(f) => setFiles(f.slice(0, 1))} title="Choose a protected PDF" />}
    >
      <Panel className="p-6 space-y-3">
        {needsPassword ? (
          <p className="text-sm">This PDF needs a password to open. Enter it and a copy without any protection is saved.</p>
        ) : (
          <p className="text-sm">
            This PDF opens without a password. Any printing, copying or editing restrictions set by its owner password are
            removed — no password needed.
          </p>
        )}
        <p className="text-xs text-muted">
          Works with every standard PDF encryption: RC4 40/128-bit, AES-128 and AES-256. Only remove protection from
          files you’re entitled to.
        </p>
        {runner.layout.error?.toLowerCase().includes('incorrect') && <Notice tone="error">That password is wrong.</Notice>}
      </Panel>
    </ToolLayout>
  );
};
