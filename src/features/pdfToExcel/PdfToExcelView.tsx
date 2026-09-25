import React, { useMemo, useState } from 'react';
import { Dropzone } from '../../components/common/Dropzone';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { Notice, ProgressLine, Segmented, Field } from '../../components/ui';
import { useToolRunner } from '../../hooks/useToolRunner';
import { useLayoutAnalysis } from '../../hooks/useLayoutAnalysis';
import { getTool } from '../../constants/tools';
import type { PageLayout } from '../../services/textLayout';
import type { PDFFile } from '../../types/pdf';
import type { OfficeConversionResult, PdfToXlsxPayload } from '../../types/worker';

interface PdfToExcelViewProps {
  initialFiles?: PDFFile[];
  onBack: () => void;
}

/** Detected tables if the page has any; otherwise every text line, split into cells at wide gaps. */
function pageRows(page: PageLayout, tablesOnly: boolean): string[][] {
  const tables = page.blocks.filter((b) => b.kind === 'table');
  if (tables.length) {
    const rows: string[][] = [];
    tables.forEach((t, i) => {
      if (i) rows.push([]);
      if (t.kind === 'table') rows.push(...t.rows);
    });
    return rows;
  }
  if (tablesOnly) return [];
  const byY = new Map<number, string[]>();
  const order: number[] = [];
  for (const l of page.lines) {
    const key = order.find((y) => Math.abs(y - l.y) < l.size * 0.4) ?? l.y;
    if (!byY.has(key)) {
      byY.set(key, []);
      order.push(key);
    }
    byY.get(key)!.push(l.text);
  }
  return order.sort((a, b) => a - b).map((y) => byY.get(y)!);
}

export const PdfToExcelView: React.FC<PdfToExcelViewProps> = ({ initialFiles = [], onBack }) => {
  const [files, setFiles] = useState<PDFFile[]>(initialFiles.slice(0, 1));
  const [layout, setLayout] = useState<'perPage' | 'single'>('perPage');
  const [scope, setScope] = useState<'tables' | 'all'>('all');
  const file = files[0];
  const analysis = useLayoutAnalysis(file?.rawBuffer);
  const runner = useToolRunner<OfficeConversionResult>(() => new Worker(new URL('./pdfToXlsx.worker.ts', import.meta.url), { type: 'module' }));

  const pages = useMemo(() => (analysis.pages ?? []).map((p) => ({ pageNumber: p.pageNumber, rows: pageRows(p, scope === 'tables') })), [analysis.pages, scope]);
  const tableCount = (analysis.pages ?? []).reduce((n, p) => n + p.blocks.filter((b) => b.kind === 'table').length, 0);
  const firstRows = pages.find((p) => p.rows.length)?.rows.slice(0, 30) ?? [];
  const cols = Math.max(0, ...firstRows.map((r) => r.length));

  const execute = () => {
    const payload: PdfToXlsxPayload = { pages, fileName: file.name, singleSheet: layout === 'single' };
    void runner.run('PDF_TO_XLSX', payload);
  };

  return (
    <ToolLayout
      tool={getTool('pdfToExcel')}
      files={files}
      onBack={onBack}
      onClearFiles={() => setFiles([])}
      onRemoveFile={() => setFiles([])}
      {...runner.layout}
      actionButtonLabel="Convert to Excel"
      onExecuteAction={execute}
      canExecute={!!analysis.pages && pages.some((p) => p.rows.length)}
      options={
        <>
          <Field label="Take">
            <Segmented value={scope} onChange={(v) => { setScope(v); runner.reset(); }} size="sm" options={[{ value: 'all', label: 'Tables + text' }, { value: 'tables', label: 'Tables only' }]} />
          </Field>
          <Field label="Sheets">
            <Segmented value={layout} onChange={(v) => { setLayout(v); runner.reset(); }} size="sm" options={[{ value: 'perPage', label: 'One per page' }, { value: 'single', label: 'All in one' }]} />
          </Field>
          {analysis.pages && <p className="font-mono text-2xs text-muted">{tableCount} table{tableCount === 1 ? '' : 's'} detected</p>}
          <p className="text-2xs text-muted">Numbers like 1,234.50, (300) and 12% become real numeric cells.</p>
        </>
      }
      emptyState={<Dropzone multiple={false} onFilesAccepted={(f) => setFiles(f.slice(0, 1))} title="Choose a PDF with tables" />}
    >
      {analysis.error && <Notice tone="error">{analysis.error}</Notice>}
      {!analysis.pages && !analysis.error && (
        <div className="max-w-sm">
          <ProgressLine progress={analysis.progress ? (analysis.progress.done / analysis.progress.total) * 100 : 0} stage="Looking for tables…" />
        </div>
      )}
      {analysis.pages && !analysis.hasText && <Notice tone="warn">No text found — this looks like a scanned PDF.</Notice>}
      {firstRows.length > 0 && (
        <div className="bg-panel border border-line rounded-md overflow-auto max-h-[65vh] scroll-thin">
          <table className="text-xs border-collapse min-w-full">
            <thead>
              <tr>
                <th className="sticky top-0 bg-sunken border-b border-r border-line w-8" />
                {Array.from({ length: cols }, (_, c) => (
                  <th key={c} className="sticky top-0 bg-sunken border-b border-r border-line px-2 py-1 font-mono text-2xs text-muted font-normal">
                    {String.fromCharCode(65 + (c % 26))}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {firstRows.map((row, r) => (
                <tr key={r}>
                  <td className="border-b border-r border-line px-1.5 font-mono text-2xs text-muted text-right bg-sunken">{r + 1}</td>
                  {Array.from({ length: cols }, (_, c) => (
                    <td key={c} className="border-b border-r border-line px-2 py-1 whitespace-nowrap max-w-[260px] truncate">
                      {row[c] ?? ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </ToolLayout>
  );
};
