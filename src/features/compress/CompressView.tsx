import React, { useState } from 'react';
import { Dropzone } from '../../components/common/Dropzone';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { Field, Panel, cn, formatBytes } from '../../components/ui';
import { useToolRunner } from '../../hooks/useToolRunner';
import { getTool } from '../../constants/tools';
import type { PDFFile } from '../../types/pdf';
import type { CompressPayload, ProcessedPdfResult } from '../../types/worker';

type Level = CompressPayload['level'];

const LEVELS: Array<{ id: Level; title: string; body: string }> = [
  { id: 'low', title: 'Light', body: 'Images to 220 dpi at high quality. Almost no visible difference.' },
  { id: 'recommended', title: 'Balanced', body: 'Images to 150 dpi at good quality. Right for email and sharing.' },
  { id: 'extreme', title: 'Smallest', body: 'Images to 96 dpi, lower quality, metadata removed.' },
  { id: 'custom', title: 'Custom size', body: 'Pick the file size you need; the best quality that fits is chosen for you.' },
];

interface CompressViewProps {
  initialFiles?: PDFFile[];
  onBack: () => void;
}

export const CompressView: React.FC<CompressViewProps> = ({ initialFiles = [], onBack }) => {
  const [files, setFiles] = useState<PDFFile[]>(initialFiles.slice(0, 1));
  const [level, setLevel] = useState<Level>('recommended');
  const [targetValue, setTargetValue] = useState('');
  const [unit, setUnit] = useState<'MB' | 'KB'>('MB');
  const runner = useToolRunner<ProcessedPdfResult>(() => new Worker(new URL('./compress.worker.ts', import.meta.url), { type: 'module' }));
  const file = files[0];

  const targetBytes = Math.round((parseFloat(targetValue) || 0) * (unit === 'MB' ? 1024 * 1024 : 1024));
  const targetError =
    level !== 'custom'
      ? null
      : !targetBytes
        ? 'Enter a size.'
        : file && targetBytes >= file.size
          ? `Must be smaller than the current ${formatBytes(file.size)} — compression only makes files smaller.`
          : targetBytes < 10 * 1024
            ? 'That’s smaller than any readable PDF page can be.'
            : null;

  const execute = () => {
    const buffer = file.rawBuffer.slice(0);
    const payload: CompressPayload = { fileBuffer: buffer, fileName: file.name, level, targetBytes: level === 'custom' ? targetBytes : undefined };
    void runner.run<CompressPayload>('COMPRESS_PDF', payload, [buffer]);
  };

  const result = runner.result;
  const saved = result && file ? 1 - result.size / file.size : 0;

  return (
    <ToolLayout
      tool={getTool('compress')}
      files={files}
      onBack={onBack}
      onClearFiles={() => setFiles([])}
      onRemoveFile={() => setFiles([])}
      {...runner.layout}
      resultNote={
        result && (
          <>
            <span className="font-mono">
              {formatBytes(file.size)} → {formatBytes(result.size)}
              {saved > 0.005 && <span className="text-ok"> (−{Math.round(saved * 100)}%)</span>}
            </span>
            {result.note && <p className="mt-1">{result.note}</p>}
          </>
        )
      }
      actionButtonLabel={level === 'custom' && targetBytes ? `Compress to ${formatBytes(targetBytes)}` : 'Compress'}
      onExecuteAction={execute}
      canExecute={!targetError}
      options={
        <Field label="Compression">
          <div className="space-y-1.5">
            {LEVELS.map((l) => (
              <button
                key={l.id}
                type="button"
                onClick={() => {
                  setLevel(l.id);
                  runner.reset();
                }}
                className={cn(
                  'w-full text-left p-2.5 rounded border transition-colors',
                  level === l.id ? 'border-ink bg-sunken' : 'border-line hover:border-line-strong'
                )}
              >
                <span className="block text-sm font-medium">{l.title}</span>
                <span className="block text-2xs text-muted leading-snug mt-0.5">{l.body}</span>
              </button>
            ))}
          </div>
          {level === 'custom' && (
            <div className="mt-3 space-y-1.5">
              <div className="flex gap-2">
                <input
                  type="number"
                  min={0}
                  step="any"
                  inputMode="decimal"
                  autoFocus
                  placeholder={file ? (file.size / 1024 / 1024 / 4).toFixed(1) : '5'}
                  className="input font-mono"
                  value={targetValue}
                  onChange={(e) => {
                    setTargetValue(e.target.value);
                    runner.reset();
                  }}
                  aria-label="Target size"
                />
                <select className="input w-20" value={unit} onChange={(e) => setUnit(e.target.value as 'MB' | 'KB')} aria-label="Unit">
                  <option>MB</option>
                  <option>KB</option>
                </select>
              </div>
              <p className={`text-2xs ${targetError && targetValue ? 'text-danger' : 'text-muted'}`}>
                {targetError && targetValue ? targetError : `Currently ${formatBytes(file?.size ?? 0)}. Only shrinks — never upscales.`}
              </p>
            </div>
          )}
        </Field>
      }
      emptyState={<Dropzone multiple={false} onFilesAccepted={(f) => setFiles(f.slice(0, 1))} title="Choose a PDF to compress" />}
    >
      <Panel className="p-6">
        <p className="label-mono">Current size</p>
        <p className="text-3xl font-semibold tracking-tight mt-1 font-mono">{formatBytes(file?.size ?? 0)}</p>
        <p className="text-xs text-muted mt-1">
          {file?.pageCount ? `${file.pageCount} pages · ` : ''}
          {file?.pageCount ? `${formatBytes((file.size ?? 0) / file.pageCount)} per page` : ''}
        </p>
        <p className="text-xs text-muted mt-4 max-w-lg leading-relaxed">
          Text and vector graphics stay sharp at every level — only photos and scans are re-encoded, and only when that
          actually makes them smaller. If a file can’t be made smaller, you get the original back.
        </p>
      </Panel>
    </ToolLayout>
  );
};
