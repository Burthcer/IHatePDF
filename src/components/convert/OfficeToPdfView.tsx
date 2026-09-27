import React, { useEffect, useState } from 'react';
import { GenericFileInput } from '../common/GenericFileInput';
import { ToolLayout } from '../layout/ToolLayout';
import { PageThumb } from '../common/PageThumb';
import { Notice, Panel } from '../ui';
import { useToolRunner } from '../../hooks/useToolRunner';
import { usePageThumbnails } from '../../hooks/usePageThumbnails';
import { getTool } from '../../constants/tools';
import type { PDFFile, ToolType } from '../../types/pdf';
import type { OfficeConversionResult } from '../../types/worker';

interface OfficeToPdfViewProps {
  toolId: ToolType;
  accept: string;
  action: string;
  workerFactory: () => Worker;
  title: string;
  subtitle: string;
  notes: React.ReactNode;
  onBack: () => void;
}

/** Shared screen for Word / Excel / PowerPoint → PDF: pick a file, convert, preview pages, download. */
export const OfficeToPdfView: React.FC<OfficeToPdfViewProps> = ({ toolId, accept, action, workerFactory, title, subtitle, notes, onBack }) => {
  const [files, setFiles] = useState<PDFFile[]>([]);
  const [wrongType, setWrongType] = useState<string | null>(null);
  const runner = useToolRunner<OfficeConversionResult>(workerFactory);
  const file = files[0];
  const { pages } = usePageThumbnails(runner.result?.buffer ?? null);

  useEffect(() => {
    if (file) void runner.run(action, { fileBuffer: file.rawBuffer.slice(0), fileName: file.name });
    // run automatically once a file is chosen
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  const onFile = async (f: File) => {
    const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
    const allowed = accept.split(',').map((a) => a.trim().replace('.', ''));
    if (!allowed.includes(ext)) {
      setWrongType(`“${f.name}” isn’t a ${allowed.map((a) => `.${a}`).join(' / ')} file.`);
      return;
    }
    setWrongType(null);
    setFiles([{ id: crypto.randomUUID(), name: f.name, size: f.size, pageCount: 0, rawBuffer: await f.arrayBuffer(), previewUrls: [] }]);
  };

  return (
    <ToolLayout
      tool={getTool(toolId)}
      files={files}
      onBack={onBack}
      onClearFiles={() => setFiles([])}
      onRemoveFile={() => setFiles([])}
      {...runner.layout}
      onReset={undefined}
      resultNote={runner.result?.pageCount ? `${runner.result.pageCount} pages` : undefined}
      actionButtonLabel="Convert again"
      onExecuteAction={() => void runner.run(action, { fileBuffer: file.rawBuffer.slice(0), fileName: file.name })}
      emptyState={
        <div className="space-y-3">
          <GenericFileInput accept={accept} title={title} subtitle={subtitle} onFileAccepted={(f) => void onFile(f)} />
          {wrongType && <Notice tone="warn">{wrongType}</Notice>}
          <Panel className="p-4 text-xs text-muted space-y-1">{notes}</Panel>
        </div>
      }
    >
      {runner.result && pages.length > 0 ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-4 gap-y-6">
          {pages.slice(0, 24).map((p, i) => (
            <PageThumb key={i} src={p.url} aspect={p.width / p.height} width={150} label={i + 1} />
          ))}
        </div>
      ) : (
        <Panel className="p-6 text-xs text-muted space-y-1">{notes}</Panel>
      )}
    </ToolLayout>
  );
};
