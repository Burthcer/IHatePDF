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
  { id: 'low', title: 'Light', body: 'Re-encodes large photos at high quality. Almost no visible difference.' },
  { id: 'recommended', title: 'Balanced', body: 'Photos down to ~200 dpi at good quality. Right for email and sharing.' },
  { id: 'extreme', title: 'Smallest', body: 'Aggressive: lower resolution and quality, metadata removed.' },
];

interface CompressViewProps {
  initialFiles?: PDFFile[];
  onBack: () => void;
}

export const CompressView: React.FC<CompressViewProps> = ({ initialFiles = [], onBack }) => {
  const [files, setFiles] = useState<PDFFile[]>(initialFiles.slice(0, 1));
  const [level, setLevel] = useState<Level>('recommended');
  const runner = useToolRunner<ProcessedPdfResult>(() => new Worker(new URL('./compress.worker.ts', import.meta.url), { type: 'module' }));
  const file = files[0];

  const execute = () => {
    const buffer = file.rawBuffer.slice(0);
    void runner.run<CompressPayload>('COMPRESS_PDF', { fileBuffer: buffer, fileName: file.name, level }, [buffer]);
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
      actionButtonLabel="Compress"
      onExecuteAction={execute}
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
