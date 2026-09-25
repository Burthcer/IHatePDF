import React, { useEffect, useRef, useState } from 'react';
import { FileUp } from 'lucide-react';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { Button, Field, Segmented, Toggle } from '../../components/ui';
import { useToolRunner } from '../../hooks/useToolRunner';
import { getTool } from '../../constants/tools';
import { captureLayout } from './captureLayout';
import type { PDFFile } from '../../types/pdf';
import type { HtmlToPdfPayload, ProcessedPdfResult } from '../../types/worker';

interface HtmlToPdfViewProps {
  onBack: () => void;
}

const SIZES = { a4: [595.28, 841.89], letter: [612, 792] } as const;
const MARGINS = { none: 0, small: 28, normal: 56 } as const;

const SAMPLE_HTML = `<style>
  body { font-family: Georgia, serif; color: #222; }
  h1 { font-family: Helvetica, Arial, sans-serif; border-bottom: 2px solid #d33; padding-bottom: 6px; }
  .note { background: #fff6d6; border-left: 4px solid #e0a800; padding: 8px 12px; }
  table { border-collapse: collapse; width: 100%; font-family: Arial, sans-serif; font-size: 13px; }
  td, th { border: 1px solid #bbb; padding: 4px 8px; text-align: left; }
  th { background: #f1efe8; }
</style>
<h1>Quarterly report</h1>
<p>Paste or type any HTML here — <strong>bold</strong>, <em>italic</em>, <u>underlined</u>, <span style="color:#1f5fbf">colored</span> text, tables, lists and images are laid out by your browser and turned into real, selectable PDF text.</p>
<p class="note">Long documents are split into pages between lines, never through them. Use <code>style="break-before: page"</code> to force a page break.</p>
<h2>Numbers</h2>
<table>
  <tr><th>Region</th><th>Q1</th><th>Q2</th></tr>
  <tr><td>North</td><td>1,204</td><td>1,390</td></tr>
  <tr><td>South</td><td>980</td><td>1,105</td></tr>
</table>
<h2>Next steps</h2>
<ol><li>Review the draft</li><li>Send it out</li></ol>`;

const BASE_CSS = `<style>html,body{margin:0;padding:0;background:#fff}body{font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.45;overflow-wrap:break-word}img{max-width:100%}pre{white-space:pre-wrap}</style>`;

export const HtmlToPdfView: React.FC<HtmlToPdfViewProps> = ({ onBack }) => {
  const [html, setHtml] = useState(SAMPLE_HTML);
  const [fileName, setFileName] = useState('document');
  const [size, setSize] = useState<keyof typeof SIZES>('a4');
  const [landscape, setLandscape] = useState(false);
  const [margin, setMargin] = useState<keyof typeof MARGINS>('normal');
  const [backgrounds, setBackgrounds] = useState(true);
  const [capturing, setCapturing] = useState(false);
  const [debounced, setDebounced] = useState(html);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const runner = useToolRunner<ProcessedPdfResult>(() => new Worker(new URL('./htmlToPdf.worker.ts', import.meta.url), { type: 'module' }));

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(html), 300);
    return () => window.clearTimeout(t);
  }, [html]);

  const [pw, ph] = landscape ? [SIZES[size][1], SIZES[size][0]] : SIZES[size];
  const contentWidthPx = ((pw - MARGINS[margin] * 2) * 96) / 72;
  const previewScale = Math.min(1, 520 / contentWidthPx);

  const execute = async () => {
    const frame = frameRef.current;
    if (!frame?.contentDocument) return;
    setCapturing(true);
    try {
      const { pages, images } = await captureLayout(frame, { pageWidthPt: pw, pageHeightPt: ph, marginPt: MARGINS[margin] });
      const filtered = backgrounds ? pages : pages.map((p) => ({ items: p.items.filter((i) => i.t !== 'rect') }));
      const title = frame.contentDocument.title || frame.contentDocument.querySelector('h1')?.textContent?.trim() || undefined;
      const payload: HtmlToPdfPayload = { pages: filtered, images, pageWidthPt: pw, pageHeightPt: ph, fileName, title };
      await runner.run('HTML_TO_PDF', payload, images);
    } finally {
      setCapturing(false);
    }
  };

  const pseudoFiles: PDFFile[] = [{ id: 'html', name: `${fileName}.html`, size: new Blob([html]).size, pageCount: 0, rawBuffer: new ArrayBuffer(0), previewUrls: [] }];

  return (
    <ToolLayout
      tool={getTool('htmlToPdf')}
      files={pseudoFiles}
      hideFileList
      onBack={onBack}
      onClearFiles={() => setHtml('')}
      onRemoveFile={() => setHtml('')}
      {...runner.layout}
      isProcessing={runner.layout.isProcessing || capturing}
      stage={capturing ? 'Measuring layout…' : runner.layout.stage}
      resultNote={runner.result?.pageCount ? `${runner.result.pageCount} page${runner.result.pageCount === 1 ? '' : 's'}` : undefined}
      actionButtonLabel="Create PDF"
      onExecuteAction={() => void execute()}
      canExecute={html.trim().length > 0}
      options={
        <>
          <Field label="File name" aside=".pdf">
            <input className="input" value={fileName} onChange={(e) => setFileName(e.target.value)} />
          </Field>
          <Field label="Page">
            <div className="flex gap-2">
              <Segmented value={size} onChange={(v) => { setSize(v); runner.reset(); }} size="sm" options={[{ value: 'a4', label: 'A4' }, { value: 'letter', label: 'Letter' }]} />
              <Segmented value={landscape ? 'l' : 'p'} onChange={(v) => { setLandscape(v === 'l'); runner.reset(); }} size="sm" options={[{ value: 'p', label: 'Portrait' }, { value: 'l', label: 'Landscape' }]} />
            </div>
          </Field>
          <Field label="Margins">
            <Segmented value={margin} onChange={(v) => { setMargin(v); runner.reset(); }} size="sm" options={[{ value: 'none', label: 'None' }, { value: 'small', label: 'Small' }, { value: 'normal', label: 'Normal' }]} />
          </Field>
          <Toggle checked={backgrounds} onChange={setBackgrounds} label="Print background colors" />
        </>
      }
    >
      <div className="grid xl:grid-cols-2 gap-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="label-mono">HTML</span>
            <Button size="sm" variant="ghost" icon={<FileUp className="w-3.5 h-3.5" />} onClick={() => uploadRef.current?.click()}>
              Open .html file
            </Button>
            <input
              ref={uploadRef}
              type="file"
              accept=".html,.htm,text/html"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                setHtml(await f.text());
                setFileName(f.name.replace(/\.[^/.]+$/, ''));
                runner.reset();
              }}
            />
          </div>
          <textarea
            className="input font-mono text-xs min-h-[520px] leading-relaxed"
            spellCheck={false}
            value={html}
            onChange={(e) => {
              setHtml(e.target.value);
              runner.reset();
            }}
          />
        </div>
        <div className="space-y-2 min-w-0">
          <span className="label-mono">Preview · content width of the page</span>
          <div className="bg-sunken border border-line rounded-md p-4 overflow-auto max-h-[560px] scroll-thin">
            <div className="bg-white shadow-page mx-auto" style={{ width: contentWidthPx * previewScale, padding: 0 }}>
              <div style={{ width: contentWidthPx, transform: `scale(${previewScale})`, transformOrigin: 'top left' }}>
                <iframe
                  ref={frameRef}
                  title="HTML preview"
                  sandbox="allow-same-origin"
                  srcDoc={`<!doctype html><html><head><meta charset="utf-8">${BASE_CSS}</head><body>${debounced}</body></html>`}
                  style={{ width: contentWidthPx, height: 1400, border: 0, display: 'block' }}
                  onLoad={(e) => {
                    const f = e.currentTarget;
                    const h = f.contentDocument?.documentElement.scrollHeight ?? 1400;
                    f.style.height = `${Math.max(200, h)}px`;
                    const wrapper = f.parentElement!.parentElement!;
                    wrapper.style.height = `${Math.max(200, h) * previewScale}px`;
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </ToolLayout>
  );
};
