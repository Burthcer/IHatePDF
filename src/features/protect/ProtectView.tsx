import React, { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Dropzone } from '../../components/common/Dropzone';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { Field, IconButton, Notice, Panel, Section, Toggle } from '../../components/ui';
import { useToolRunner } from '../../hooks/useToolRunner';
import { getTool } from '../../constants/tools';
import type { PDFFile } from '../../types/pdf';
import type { ProcessedPdfResult, ProtectPayload } from '../../types/worker';

interface ProtectViewProps {
  initialFiles?: PDFFile[];
  onBack: () => void;
}

function strength(pw: string): { label: string; tone: 'error' | 'warn' | 'ok' } {
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  if (score <= 1) return { label: 'Weak', tone: 'error' };
  if (score <= 3) return { label: 'Fair', tone: 'warn' };
  return { label: 'Strong', tone: 'ok' };
}

export const ProtectView: React.FC<ProtectViewProps> = ({ initialFiles = [], onBack }) => {
  const [files, setFiles] = useState<PDFFile[]>(initialFiles.slice(0, 1));
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [useOwner, setUseOwner] = useState(false);
  const [ownerPassword, setOwnerPassword] = useState('');
  const [perms, setPerms] = useState({ printing: true, copying: true, modifying: true, annotating: true });
  const runner = useToolRunner<ProcessedPdfResult>(() => new Worker(new URL('./protect.worker.ts', import.meta.url), { type: 'module' }));
  const file = files[0];

  const mismatch = confirm.length > 0 && confirm !== password;
  const canRun = password.length > 0 && password === confirm && (!useOwner || ownerPassword.length > 0);
  const s = strength(password);

  const execute = () => {
    const payload: ProtectPayload = {
      fileBuffer: file.data,
      fileName: file.name,
      userPassword: password,
      // Restrictions only mean something if the owner password differs from
      // the open password; without one, use a random throwaway.
      ownerPassword: useOwner
        ? ownerPassword
        : Object.values(perms).some((v) => !v)
          ? Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('')
          : undefined,
      permissions: perms,
    };
    void runner.run('PROTECT_PDF', payload);
  };

  const set = (patch: Partial<typeof perms>) => {
    setPerms((p) => ({ ...p, ...patch }));
    runner.reset();
  };

  return (
    <ToolLayout
      tool={getTool('protect')}
      files={files}
      onBack={onBack}
      onClearFiles={() => setFiles([])}
      onRemoveFile={() => setFiles([])}
      {...runner.layout}
      actionButtonLabel="Encrypt PDF"
      onExecuteAction={execute}
      canExecute={canRun}
      options={
        <>
          <Field label="Password" aside={password ? s.label : undefined}>
            <div className="relative">
              <input
                type={show ? 'text' : 'password'}
                className="input pr-9"
                value={password}
                autoComplete="new-password"
                onChange={(e) => {
                  setPassword(e.target.value);
                  runner.reset();
                }}
              />
              <IconButton label={show ? 'Hide password' : 'Show password'} size="sm" className="absolute right-0.5 top-0.5" onClick={() => setShow((v) => !v)}>
                {show ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </IconButton>
            </div>
          </Field>
          <Field label="Repeat password" hint={mismatch ? 'Passwords don’t match.' : undefined}>
            <input type={show ? 'text' : 'password'} className="input" value={confirm} autoComplete="new-password" onChange={(e) => setConfirm(e.target.value)} />
          </Field>
          <Section title="Permissions">
            <div className="space-y-2">
              <Toggle checked={perms.printing} onChange={(v) => set({ printing: v })} label="Allow printing" />
              <Toggle checked={perms.copying} onChange={(v) => set({ copying: v })} label="Allow copying text and images" />
              <Toggle checked={perms.modifying} onChange={(v) => set({ modifying: v })} label="Allow changes" />
              <Toggle checked={perms.annotating} onChange={(v) => set({ annotating: v })} label="Allow comments and form filling" />
            </div>
            <Toggle
              checked={useOwner}
              onChange={setUseOwner}
              label="Separate owner password"
              hint="Lets you lift the restrictions later. Without it, restrictions are locked in with a random owner password."
            />
            {useOwner && (
              <Field label="Owner password">
                <input type="password" className="input" value={ownerPassword} autoComplete="new-password" onChange={(e) => setOwnerPassword(e.target.value)} />
              </Field>
            )}
          </Section>
        </>
      }
      emptyState={<Dropzone multiple={false} onFilesAccepted={(f) => setFiles(f.slice(0, 1))} title="Choose a PDF to protect" />}
    >
      <Panel className="p-6 space-y-3">
        <p className="text-sm">
          The file is encrypted with <span className="font-medium">AES-256</span> (PDF 2.0, security revision 6). It opens
          in Acrobat, Preview, Chrome, Firefox, Edge and other current readers once the password is entered.
        </p>
        <p className="text-xs text-muted">
          There is no way to recover a forgotten password — keep it somewhere safe. Permission restrictions are honored by
          well-behaved readers but aren’t a hard security boundary; the password is.
        </p>
        {file?.wasProtected && <Notice tone="info">This file was already protected; its old password is replaced by the new one.</Notice>}
      </Panel>
    </ToolLayout>
  );
};
