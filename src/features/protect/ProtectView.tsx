import React, { useState } from 'react';
import { Dropzone } from '../../components/common/Dropzone';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { useWorkerBridge } from '../../hooks/useWorkerBridge';
import { memoryManager } from '../../services/memoryManager';
import { Lock, Eye, EyeOff, ShieldAlert } from 'lucide-react';
import type { PDFFile, ToolMetadata } from '../../types/pdf';
import type { ProtectPayload, ProcessedPdfResult } from '../../types/worker';

const PERMISSION_OPTIONS: Array<{ key: keyof NonNullable<ProtectPayload['permissions']>; label: string }> = [
  { key: 'printing', label: 'Allow printing' },
  { key: 'modifying', label: 'Allow editing content' },
  { key: 'copying', label: 'Allow copying text & images' },
  { key: 'annotating', label: 'Allow annotations & form filling' },
];

const PROTECT_TOOL_METADATA: ToolMetadata = {
  id: 'protect',
  title: 'Protect PDF',
  description: 'Encrypt your PDF with a password to prevent unauthorized viewing and copying.',
  icon: 'Lock',
  color: '#475569',
  category: 'security',
  acceptedFiles: 'single',
};

interface ProtectViewProps {
  initialFiles?: PDFFile[];
  onBack: () => void;
}

export const ProtectView: React.FC<ProtectViewProps> = ({ initialFiles = [], onBack }) => {
  const [files, setFiles] = useState<PDFFile[]>(initialFiles);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [result, setResult] = useState<ProcessedPdfResult | null>(null);
  const [permissions, setPermissions] = useState<NonNullable<ProtectPayload['permissions']>>({
    printing: true,
    modifying: true,
    copying: true,
    annotating: true,
  });

  const { runTask, isProcessing, progress, stage, error, resetState } =
    useWorkerBridge<ProcessedPdfResult>(
      () => new Worker(new URL('./protect.worker.ts', import.meta.url), { type: 'module' })
    );

  const handleFilesAccepted = (acceptedFiles: PDFFile[]) => {
    const single = acceptedFiles.slice(0, 1);
    setFiles(single);
    setResult(null);
    resetState();
  };

  const handleClearFiles = () => {
    setFiles([]);
    setPassword('');
    setConfirmPassword('');
    setValidationError(null);
    setResult(null);
    resetState();
  };

  const executeProtect = async () => {
    if (files.length === 0) return;

    if (!password) {
      setValidationError('Please enter an encryption password.');
      return;
    }

    if (password !== confirmPassword) {
      setValidationError('Passwords do not match. Please verify your entries.');
      return;
    }

    setValidationError(null);
    const file = files[0];

    try {
      const bufferCopy = file.rawBuffer.slice(0);
      const payload: ProtectPayload = {
        fileBuffer: bufferCopy,
        fileName: file.name,
        userPassword: password,
        permissions,
      };

      const res = await runTask<ProtectPayload>('PROTECT_PDF', payload, [bufferCopy]);
      setResult(res);
    } catch (err) {
      console.error('Protect error:', err);
    }
  };

  const handleDownload = () => {
    if (result) {
      memoryManager.downloadBuffer(result.buffer, result.fileName);
    }
  };

  const canExecute = files.length > 0 && password.length > 0 && password === confirmPassword;

  return (
    <ToolLayout
      tool={PROTECT_TOOL_METADATA}
      accentColor="#475569"
      files={files}
      onBack={onBack}
      onClearFiles={handleClearFiles}
      onRemoveFile={handleClearFiles}
      isProcessing={isProcessing}
      progress={progress}
      stage={stage}
      error={error}
      resultBuffer={result?.buffer || null}
      resultFileName={result?.fileName || 'protected_document.pdf'}
      onDownloadResult={handleDownload}
      actionButtonLabel="Encrypt & Protect"
      onExecuteAction={executeProtect}
      canExecute={canExecute}
    >
      {files.length === 0 ? (
        <Dropzone
          multiple={false}
          onFilesAccepted={handleFilesAccepted}
          title="Select a PDF file to Protect"
          subtitle="Password-encrypt your document offline"
        />
      ) : (
        <div className="space-y-6">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-xs space-y-6 max-w-xl mx-auto">
            <h3 className="font-bold text-lg text-slate-900 dark:text-white flex items-center gap-2">
              <Lock className="w-5 h-5 text-indigo-600" />
              <span>Set Document Password</span>
            </h3>

            <div className="space-y-4">
              <div>
                <label
                  htmlFor="protect-password"
                  className="block text-xs font-bold uppercase tracking-wider text-slate-600 dark:text-slate-400 mb-1.5"
                >
                  Password
                </label>
                <div className="relative">
                  <input
                    id="protect-password"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      setValidationError(null);
                    }}
                    placeholder="Enter strong password..."
                    className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-800/80 border border-slate-300 dark:border-slate-700 rounded-xl text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div>
                <label
                  htmlFor="protect-confirm-password"
                  className="block text-xs font-bold uppercase tracking-wider text-slate-600 dark:text-slate-400 mb-1.5"
                >
                  Confirm Password
                </label>
                <input
                  id="protect-confirm-password"
                  type={showPassword ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={(e) => {
                    setConfirmPassword(e.target.value);
                    setValidationError(null);
                  }}
                  placeholder="Re-type password..."
                  className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-800/80 border border-slate-300 dark:border-slate-700 rounded-xl text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              {validationError && (
                <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 pt-1">
                  <ShieldAlert className="w-4 h-4 shrink-0" />
                  <span>{validationError}</span>
                </div>
              )}

              <div>
                <span className="block text-xs font-bold uppercase tracking-wider text-slate-600 dark:text-slate-400 mb-2">
                  Permissions
                </span>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {PERMISSION_OPTIONS.map(({ key, label }) => (
                    <label
                      key={key}
                      className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={permissions[key] ?? true}
                        onChange={(e) =>
                          setPermissions((prev) => ({ ...prev, [key]: e.target.checked }))
                        }
                        className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                      />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="p-3 bg-indigo-50 dark:bg-indigo-950/30 rounded-xl border border-indigo-200 dark:border-indigo-900/60 text-xs text-indigo-800 dark:text-indigo-300 leading-relaxed">
                Remember your password. IHatePDF operates without servers, so forgotten passwords cannot be recovered or reset by anyone.
              </div>
            </div>
          </div>
        </div>
      )}
    </ToolLayout>
  );
};
