import React, { useMemo, useRef, useState } from 'react';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { useWorkerBridge } from '../../hooks/useWorkerBridge';
import { memoryManager } from '../../services/memoryManager';
import { Code2, Upload } from 'lucide-react';
import type { PDFFile, ToolMetadata } from '../../types/pdf';
import type { HtmlBlock, HtmlToPdfPayload, ProcessedPdfResult } from '../../types/worker';

const TOOL_METADATA: ToolMetadata = {
  id: 'htmlToPdf',
  title: 'HTML to PDF',
  description: 'Convert HTML content into a formatted PDF document.',
  icon: 'Code2',
  color: '#F59E0B',
  category: 'convert',
  acceptedFiles: 'single',
};

interface HtmlToPdfViewProps {
  onBack: () => void;
}

const SAMPLE_HTML = `<h1>Document Title</h1>
<p>This is an introductory paragraph. Paste your own HTML here, or upload an .html file.</p>
<h2>Section Heading</h2>
<p>Structure — headings, paragraphs, and lists — is preserved. CSS layout, images, and colors are not.</p>
<ul>
  <li>First point</li>
  <li>Second point</li>
</ul>`;

const BLOCK_TAGS = new Set(['h1', 'h2', 'h3', 'p', 'li']);

function parseHtmlToBlocks(html: string): HtmlBlock[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const blocks: HtmlBlock[] = [];
  doc.body.querySelectorAll('h1,h2,h3,p,li').forEach((el) => {
    const text = el.textContent?.trim();
    if (!text) return;
    const tag = el.tagName.toLowerCase();
    const type = (BLOCK_TAGS.has(tag) ? tag : 'p') as HtmlBlock['type'];
    const onlyChild = el.children.length === 1 ? el.children[0] : null;
    const bold = !!onlyChild && ['B', 'STRONG'].includes(onlyChild.tagName);
    const italic = !!onlyChild && ['I', 'EM'].includes(onlyChild.tagName);
    blocks.push({ type, text, bold, italic });
  });
  return blocks;
}

export const HtmlToPdfView: React.FC<HtmlToPdfViewProps> = ({ onBack }) => {
  const [html, setHtml] = useState(SAMPLE_HTML);
  const [fileName, setFileName] = useState('document');
  const [result, setResult] = useState<ProcessedPdfResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { runTask, isProcessing, progress, stage, error, resetState } =
    useWorkerBridge<ProcessedPdfResult>(
      () => new Worker(new URL('./htmlToPdf.worker.ts', import.meta.url), { type: 'module' })
    );

  const blocks = useMemo(() => parseHtmlToBlocks(html), [html]);

  // ToolLayout only shows its sidebar (progress/result/action button) once
  // `files` is non-empty — synthesize one placeholder "file" representing
  // the in-editor HTML source so that sidebar is always available here.
  const syntheticFiles = useMemo<PDFFile[]>(
    () => [
      {
        id: 'html-source',
        name: `${fileName || 'document'}.html`,
        size: html.length,
        pageCount: 0,
        rawBuffer: new ArrayBuffer(0),
        previewUrls: [],
      },
    ],
    [fileName, html.length]
  );

  const handleUploadClick = () => fileInputRef.current?.click();

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const text = await file.text();
    setHtml(text);
    setFileName(file.name.replace(/\.[^/.]+$/, ''));
    setResult(null);
    resetState();
  };

  const executeConvert = async () => {
    if (blocks.length === 0) return;
    try {
      const payload: HtmlToPdfPayload = { blocks, fileName };
      const res = await runTask<HtmlToPdfPayload>('HTML_TO_PDF', payload);
      setResult(res);
    } catch (err) {
      console.error('HTML to PDF error:', err);
    }
  };

  const handleDownload = () => {
    if (result) memoryManager.downloadBuffer(result.buffer, result.fileName);
  };

  return (
    <ToolLayout
      tool={TOOL_METADATA}
      accentColor="#F59E0B"
      files={syntheticFiles}
      onBack={onBack}
      onClearFiles={() => setHtml('')}
      onRemoveFile={() => setHtml('')}
      isProcessing={isProcessing}
      progress={progress}
      stage={stage}
      error={error}
      resultBuffer={result?.buffer || null}
      resultFileName={result?.fileName || 'document.pdf'}
      onDownloadResult={handleDownload}
      actionButtonLabel="Convert to PDF"
      onExecuteAction={executeConvert}
      canExecute={blocks.length > 0}
    >
      <div className="max-w-3xl mx-auto space-y-4">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-lg text-slate-900 dark:text-white flex items-center gap-2">
              <Code2 className="w-5 h-5 text-[#F59E0B]" />
              <span>HTML Source</span>
            </h3>
            <button
              onClick={handleUploadClick}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 rounded-lg"
            >
              <Upload className="w-3.5 h-3.5" />
              <span>Upload .html</span>
            </button>
            <input ref={fileInputRef} type="file" accept=".html,.htm,text/html" className="hidden" onChange={handleFileSelected} />
          </div>

          <textarea
            value={html}
            onChange={(e) => {
              setHtml(e.target.value);
              setResult(null);
              resetState();
            }}
            spellCheck={false}
            className="w-full h-64 px-3 py-2.5 bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-xs font-mono text-slate-900 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-amber-500"
          />

          <p className="text-xs text-slate-500 dark:text-slate-400">
            Recognizes &lt;h1&gt;–&lt;h3&gt;, &lt;p&gt;, and &lt;li&gt; elements — {blocks.length} block
            {blocks.length === 1 ? '' : 's'} detected. Preserves document structure, not CSS layout or images.
          </p>
        </div>
      </div>
    </ToolLayout>
  );
};
