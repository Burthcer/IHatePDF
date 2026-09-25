import React, { useState } from 'react';
import { Dropzone } from '../../components/common/Dropzone';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { PositionGrid } from '../../components/common/PositionGrid';
import { PageThumb } from '../../components/common/PageThumb';
import { ColorInput, Field, Slider, Spinner, Toggle } from '../../components/ui';
import { useToolRunner } from '../../hooks/useToolRunner';
import { usePageThumbnails } from '../../hooks/usePageThumbnails';
import { toRoman } from '../../services/pdfStampPosition';
import { getTool } from '../../constants/tools';
import type { PDFFile } from '../../types/pdf';
import type { PageNumbersPayload, ProcessedPdfResult, WatermarkPosition } from '../../types/worker';

interface PageNumbersViewProps {
  initialFiles?: PDFFile[];
  onBack: () => void;
}

type Style = 'n' | 'page_n' | 'n_of_total' | 'roman' | 'custom';

const TEMPLATES: Record<Exclude<Style, 'custom'>, string> = {
  n: '{n}',
  page_n: 'Page {n}',
  n_of_total: 'Page {n} of {total}',
  roman: '{roman}',
};

const ALLOWED: WatermarkPosition[] = ['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right'];

export const PageNumbersView: React.FC<PageNumbersViewProps> = ({ initialFiles = [], onBack }) => {
  const [files, setFiles] = useState<PDFFile[]>(initialFiles.slice(0, 1));
  const [style, setStyle] = useState<Style>('n');
  const [custom, setCustom] = useState('{n} / {total}');
  const [position, setPosition] = useState<WatermarkPosition>('bottom-center');
  const [fontSize, setFontSize] = useState(10);
  const [color, setColor] = useState('#333333');
  const [margin, setMargin] = useState(10);
  const [firstPage, setFirstPage] = useState(1);
  const [startAt, setStartAt] = useState(1);
  const [mirror, setMirror] = useState(false);
  const file = files[0];
  const { pages } = usePageThumbnails(file?.rawBuffer, 110);
  const runner = useToolRunner<ProcessedPdfResult>(() => new Worker(new URL('./pageNumbers.worker.ts', import.meta.url), { type: 'module' }));
  const total = pages.length || file?.pageCount || 1;
  const template = style === 'custom' ? custom : TEMPLATES[style];
  const lastNumber = startAt + (total - firstPage);
  const labelFor = (n: number) => template.replace(/\{n\}/g, String(n)).replace(/\{total\}/g, String(lastNumber)).replace(/\{roman\}/g, toRoman(n));

  const touch = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    runner.reset();
  };

  const execute = () => {
    const buffer = file.rawBuffer.slice(0);
    const payload: PageNumbersPayload = {
      fileBuffer: buffer,
      fileName: file.name,
      format: 'n',
      template,
      position,
      fontSize,
      color,
      marginMm: margin,
      startPage: firstPage,
      startingNumber: startAt,
      mirror,
    };
    void runner.run('ADD_PAGE_NUMBERS', payload, [buffer]);
  };

  return (
    <ToolLayout
      tool={getTool('pageNumbers')}
      files={files}
      onBack={onBack}
      onClearFiles={() => setFiles([])}
      onRemoveFile={() => setFiles([])}
      {...runner.layout}
      actionButtonLabel="Add page numbers"
      onExecuteAction={execute}
      canExecute={template.includes('{n}') || template.includes('{roman}')}
      options={
        <>
          <Field label="Style">
            <select className="input" value={style} onChange={(e) => touch(setStyle)(e.target.value as Style)}>
              <option value="n">1, 2, 3</option>
              <option value="page_n">Page 1</option>
              <option value="n_of_total">Page 1 of N</option>
              <option value="roman">i, ii, iii</option>
              <option value="custom">Custom…</option>
            </select>
          </Field>
          {style === 'custom' && (
            <Field label="Template" hint="{n} number · {total} last number · {roman} roman numeral">
              <input className="input font-mono" value={custom} onChange={(e) => touch(setCustom)(e.target.value)} />
            </Field>
          )}
          <div className="flex gap-4 items-start">
            <Field label="Position">
              <PositionGrid value={position} onChange={touch(setPosition)} allowed={ALLOWED} />
            </Field>
            <div className="space-y-3 flex-1">
              <Field label="Size" aside="pt">
                <input type="number" min={5} max={72} className="input font-mono" value={fontSize} onChange={(e) => touch(setFontSize)(Number(e.target.value) || 10)} />
              </Field>
              <ColorInput value={color} onChange={touch(setColor)} />
            </div>
          </div>
          <Slider label="Distance from edge" min={3} max={40} value={margin} onChange={touch(setMargin)} format={(v) => `${v} mm`} />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start on page">
              <input type="number" min={1} max={total} className="input font-mono" value={firstPage} onChange={(e) => touch(setFirstPage)(Math.min(total, Math.max(1, Number(e.target.value) || 1)))} />
            </Field>
            <Field label="First number">
              <input type="number" min={0} className="input font-mono" value={startAt} onChange={(e) => touch(setStartAt)(Math.max(0, Number(e.target.value) || 0))} />
            </Field>
          </div>
          <Toggle checked={mirror} onChange={touch(setMirror)} label="Mirror on even pages" hint="Left/right swap on facing pages, for double-sided printing." />
        </>
      }
      emptyState={<Dropzone multiple={false} onFilesAccepted={(f) => setFiles(f.slice(0, 1))} title="Choose a PDF to number" />}
    >
      {pages.length === 0 ? (
        <div className="flex items-center gap-2 text-sm text-muted py-10 justify-center">
          <Spinner /> Loading pages…
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-x-4 gap-y-6">
          {pages.slice(0, 24).map((p, i) => {
            const numbered = i + 1 >= firstPage;
            const n = startAt + (i + 1 - firstPage);
            const pos = mirror && (i + 1 - firstPage) % 2 === 1 ? (position.endsWith('left') ? position.replace('left', 'right') : position.replace('right', 'left')) : position;
            const [v, h] = pos.split('-');
            return (
              <PageThumb key={i} src={p.url} aspect={p.width / p.height} width={120} label={i + 1} dimmed={!numbered}>
                {numbered && (
                  <span
                    className="absolute font-mono text-[9px] text-accent bg-panel/90 px-0.5 whitespace-nowrap"
                    style={{
                      top: v === 'top' ? 8 : undefined,
                      bottom: v === 'bottom' ? 8 : undefined,
                      left: h === 'left' ? 10 : h === 'center' ? '50%' : undefined,
                      right: h === 'right' ? 10 : undefined,
                      transform: h === 'center' ? 'translateX(-50%)' : undefined,
                    }}
                  >
                    {labelFor(n)}
                  </span>
                )}
              </PageThumb>
            );
          })}
        </div>
      )}
    </ToolLayout>
  );
};
