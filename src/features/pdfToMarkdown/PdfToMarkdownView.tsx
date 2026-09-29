import React, { useMemo, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Dropzone } from '../../components/common/Dropzone';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { Button, Notice, ProgressLine, Toggle } from '../../components/ui';
import { useLayoutAnalysis } from '../../hooks/useLayoutAnalysis';
import { layoutToMarkdown } from '../../services/layoutToMarkdown';
import { saveResult } from '../../services/toolOutput';
import { getTool } from '../../constants/tools';
import type { PDFFile } from '../../types/pdf';

interface PdfToMarkdownViewProps {
  initialFiles?: PDFFile[];
  onBack: () => void;
}

export const PdfToMarkdownView: React.FC<PdfToMarkdownViewProps> = ({ initialFiles = [], onBack }) => {
  const [files, setFiles] = useState<PDFFile[]>(initialFiles.slice(0, 1));
  const [pageMarkers, setPageMarkers] = useState(false);
  const [emphasis, setEmphasis] = useState(true);
  const [copied, setCopied] = useState(false);
  const file = files[0];
  const analysis = useLayoutAnalysis(file?.data);
  const markdown = useMemo(() => (analysis.pages ? layoutToMarkdown(analysis.pages, { pageHeadings: pageMarkers, emphasis }) : ''), [analysis.pages, pageMarkers, emphasis]);
  const buffer = useMemo(() => (markdown ? (new TextEncoder().encode(markdown).buffer as ArrayBuffer) : null), [markdown]);
  const outName = `${(file?.name ?? 'document').replace(/\.[^/.]+$/, '')}.md`;

  return (
    <ToolLayout
      tool={getTool('pdfToMarkdown')}
      files={files}
      onBack={onBack}
      onClearFiles={() => setFiles([])}
      onRemoveFile={() => setFiles([])}
      isProcessing={!analysis.pages && !analysis.error && !!file}
      progress={analysis.progress ? (analysis.progress.done / analysis.progress.total) * 100 : 0}
      stage={analysis.progress ? `Reading page ${analysis.progress.done} of ${analysis.progress.total}…` : 'Reading document…'}
      error={analysis.error}
      resultData={analysis.pages && analysis.hasText ? buffer : null}
      resultFileName={outName}
      onDownloadResult={(name) => buffer && void saveResult(buffer, name || outName, 'text/markdown')}
      resultNote={
        <div className="space-y-3 mt-2">
          <Toggle checked={emphasis} onChange={setEmphasis} label="Keep bold and italic" />
          <Toggle checked={pageMarkers} onChange={setPageMarkers} label="Mark page boundaries" />
        </div>
      }
      actionButtonLabel="Convert"
      onExecuteAction={() => undefined}
      emptyState={<Dropzone multiple={false} onFilesAccepted={(f) => setFiles(f.slice(0, 1))} title="Choose a PDF to convert" />}
    >
      {analysis.pages && !analysis.hasText && (
        <Notice tone="warn" title="No text found">
          This PDF looks like a scan, so there’s no text to extract.
        </Notice>
      )}
      {!analysis.pages && !analysis.error && (
        <div className="max-w-sm">
          <ProgressLine progress={analysis.progress ? (analysis.progress.done / analysis.progress.total) * 100 : 0} stage="Analyzing layout…" />
        </div>
      )}
      {markdown && analysis.hasText && (
        <div className="relative">
          <Button
            size="sm"
            className="absolute right-3 top-3"
            icon={copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            onClick={() => {
              void navigator.clipboard.writeText(markdown).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <pre className="bg-panel border border-line rounded-md p-4 pr-24 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words max-h-[70vh] overflow-auto scroll-thin">{markdown}</pre>
        </div>
      )}
    </ToolLayout>
  );
};
