import React, { useMemo, useState } from 'react';
import { Header } from './components/common/Header';
import { Footer } from './components/common/Footer';
import { PrivacyBadge } from './components/common/PrivacyBadge';
import { Dropzone } from './components/common/Dropzone';
import { PdfPreviewGrid } from './components/common/PdfPreviewGrid';
import { ToolCard } from './components/catalog/ToolCard';
import { memoryManager } from './services/memoryManager';
import { TOOLS } from './constants/tools';
import { MergeView } from './features/merge/MergeView';
import { SplitView } from './features/split/SplitView';
import { RotateView } from './features/rotate/RotateView';
import { OrganizeView } from './features/organize/OrganizeView';
import { CropView } from './features/crop/CropView';
import { CompressView } from './features/compress/CompressView';
import { ProtectView } from './features/protect/ProtectView';
import { UnlockView } from './features/unlock/UnlockView';
import { WatermarkView } from './features/watermark/WatermarkView';
import { PageNumbersView } from './features/pageNumbers/PageNumbersView';
import { PdfToWordView } from './features/pdfToWord/PdfToWordView';
import { WordToPdfView } from './features/wordToPdf/WordToPdfView';
import { PdfToPptView } from './features/pdfToPpt/PdfToPptView';
import { PptToPdfView } from './features/pptToPdf/PptToPdfView';
import { PdfToJpgView } from './features/pdfToJpg/PdfToJpgView';
import { ImageToPdfView } from './features/imageToPdf/ImageToPdfView';
import { PdfToMarkdownView } from './features/pdfToMarkdown/PdfToMarkdownView';
import { RepairView } from './features/repair/RepairView';
import { FormsView } from './features/forms/FormsView';
import { SignView } from './features/sign/SignView';
import { PdfToPdfaView } from './features/pdfToPdfa/PdfToPdfaView';
import { PdfToExcelView } from './features/pdfToExcel/PdfToExcelView';
import { ExcelToPdfView } from './features/excelToPdf/ExcelToPdfView';
import { CompareView } from './features/compare/CompareView';
import { ScanToPdfView } from './features/scanToPdf/ScanToPdfView';
import { EditPdfView } from './features/editPdf/EditPdfView';
import { HtmlToPdfView } from './features/htmlToPdf/HtmlToPdfView';
import { RedactView } from './features/redact/RedactView';
import type { ToolType, ToolCategory, PDFFile } from './types/pdf';

// Tools that don't take a single-PDF input, so they aren't reachable via the
// global PDF-only ingestion dropzone below — only via their own catalog card.
const NON_PDF_INPUT_TOOLS = new Set<ToolType>([
  'wordToPdf',
  'pptToPdf',
  'imageToPdf',
  'excelToPdf',
  'compare',
  'scanToPdf',
  'htmlToPdf',
]);

const CATEGORIES: Array<{ id: ToolCategory | 'all'; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'organize', label: 'Organize' },
  { id: 'optimize', label: 'Optimize' },
  { id: 'convert', label: 'Convert' },
  { id: 'edit', label: 'Edit' },
  { id: 'security', label: 'Security' },
];

export function App() {
  const [activeTool, setActiveTool] = useState<ToolType | null>(null);
  const [ingestedFiles, setIngestedFiles] = useState<PDFFile[]>([]);
  const [previewFiles, setPreviewFiles] = useState<PDFFile[]>([]);
  const [selectedQuickTool, setSelectedQuickTool] = useState<ToolType>('merge');
  const [category, setCategory] = useState<ToolCategory | 'all'>('all');

  const filteredTools = useMemo(
    () => (category === 'all' ? TOOLS : TOOLS.filter((t) => t.category === category)),
    [category]
  );

  const handleGlobalFilesAccepted = (files: PDFFile[]) => {
    // Show a verification preview grid before committing to a tool
    setPreviewFiles(files);
  };

  const handlePreviewReset = () => {
    setPreviewFiles([]);
  };

  const handlePreviewContinue = () => {
    setIngestedFiles(previewFiles);
    setActiveTool(previewFiles.length > 1 ? 'merge' : selectedQuickTool || 'compress');
    setPreviewFiles([]);
  };

  const handleToolSelect = (toolId: ToolType) => {
    setActiveTool(toolId);
  };

  const handleBackToCatalog = () => {
    memoryManager.revokeAllUrls();
    setActiveTool(null);
    setIngestedFiles([]);
    setPreviewFiles([]);
  };

  return (
    <div className="min-h-screen flex flex-col bg-canvas-light dark:bg-canvas-dark">
      <Header
        activeTool={activeTool}
        onSelectTool={setActiveTool}
        category={category}
        onSelectCategory={setCategory}
        categories={CATEGORIES}
      />

      <main className="flex-1">
        {/* Render Active Tool View */}
        {activeTool === 'merge' && (
          <MergeView initialFiles={ingestedFiles} onBack={handleBackToCatalog} />
        )}
        {activeTool === 'split' && (
          <SplitView initialFiles={ingestedFiles} onBack={handleBackToCatalog} />
        )}
        {activeTool === 'rotate' && (
          <RotateView initialFiles={ingestedFiles} onBack={handleBackToCatalog} />
        )}
        {activeTool === 'organize' && (
          <OrganizeView initialFiles={ingestedFiles} onBack={handleBackToCatalog} />
        )}
        {activeTool === 'crop' && (
          <CropView initialFiles={ingestedFiles} onBack={handleBackToCatalog} />
        )}
        {activeTool === 'compress' && (
          <CompressView initialFiles={ingestedFiles} onBack={handleBackToCatalog} />
        )}
        {activeTool === 'protect' && (
          <ProtectView initialFiles={ingestedFiles} onBack={handleBackToCatalog} />
        )}
        {activeTool === 'unlock' && (
          <UnlockView initialFiles={ingestedFiles} onBack={handleBackToCatalog} />
        )}
        {activeTool === 'watermark' && (
          <WatermarkView initialFiles={ingestedFiles} onBack={handleBackToCatalog} />
        )}
        {activeTool === 'pageNumbers' && (
          <PageNumbersView initialFiles={ingestedFiles} onBack={handleBackToCatalog} />
        )}
        {activeTool === 'pdfToWord' && (
          <PdfToWordView initialFiles={ingestedFiles} onBack={handleBackToCatalog} />
        )}
        {activeTool === 'wordToPdf' && <WordToPdfView onBack={handleBackToCatalog} />}
        {activeTool === 'pdfToPpt' && (
          <PdfToPptView initialFiles={ingestedFiles} onBack={handleBackToCatalog} />
        )}
        {activeTool === 'pptToPdf' && <PptToPdfView onBack={handleBackToCatalog} />}
        {activeTool === 'pdfToJpg' && (
          <PdfToJpgView initialFiles={ingestedFiles} onBack={handleBackToCatalog} />
        )}
        {activeTool === 'imageToPdf' && <ImageToPdfView onBack={handleBackToCatalog} />}
        {activeTool === 'pdfToMarkdown' && (
          <PdfToMarkdownView initialFiles={ingestedFiles} onBack={handleBackToCatalog} />
        )}
        {activeTool === 'repair' && (
          <RepairView initialFiles={ingestedFiles} onBack={handleBackToCatalog} />
        )}
        {activeTool === 'forms' && (
          <FormsView initialFiles={ingestedFiles} onBack={handleBackToCatalog} />
        )}
        {activeTool === 'sign' && (
          <SignView initialFiles={ingestedFiles} onBack={handleBackToCatalog} />
        )}
        {activeTool === 'pdfToPdfa' && (
          <PdfToPdfaView initialFiles={ingestedFiles} onBack={handleBackToCatalog} />
        )}
        {activeTool === 'pdfToExcel' && (
          <PdfToExcelView initialFiles={ingestedFiles} onBack={handleBackToCatalog} />
        )}
        {activeTool === 'excelToPdf' && <ExcelToPdfView onBack={handleBackToCatalog} />}
        {activeTool === 'compare' && <CompareView onBack={handleBackToCatalog} />}
        {activeTool === 'scanToPdf' && <ScanToPdfView onBack={handleBackToCatalog} />}
        {activeTool === 'editPdf' && (
          <EditPdfView initialFiles={ingestedFiles} onBack={handleBackToCatalog} />
        )}
        {activeTool === 'htmlToPdf' && <HtmlToPdfView onBack={handleBackToCatalog} />}
        {activeTool === 'redact' && (
          <RedactView initialFiles={ingestedFiles} onBack={handleBackToCatalog} />
        )}

        {/* Render Document Verification Preview Grid after ingestion */}
        {!activeTool && previewFiles.length > 0 && (
          <div className="py-10 px-4 sm:px-6 lg:px-8">
            <PdfPreviewGrid
              files={previewFiles}
              onReset={handlePreviewReset}
              onContinue={handlePreviewContinue}
            />
          </div>
        )}

        {/* Render Catalog & Home Page when no tool selected */}
        {!activeTool && previewFiles.length === 0 && (
          <div className="space-y-12 py-10 px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto">
            {/* Hero */}
            <div className="text-center space-y-4 max-w-2xl mx-auto">
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-bold uppercase tracking-wide bg-brand-50 dark:bg-brand-950/50 text-brand-700 dark:text-brand-400">
                100% in your browser
              </span>
              <h1 className="text-3xl sm:text-5xl font-bold text-slate-900 dark:text-white tracking-tight">
                Every tool you need to work with <span className="text-brand-600">PDFs</span>.
              </h1>
              <p className="text-base text-slate-600 dark:text-slate-400 max-w-xl mx-auto">
                No uploads, no paywalls, no page limits. Everything runs locally in your browser.
              </p>
            </div>

            {/* Universal Ingestion Zone */}
            <div className="max-w-2xl mx-auto bg-white dark:bg-slate-900 p-6 rounded-3xl shadow-soft dark:shadow-soft-dark space-y-5">
              <div className="flex flex-col sm:flex-row items-center justify-between gap-3 border-b border-slate-100 dark:border-slate-800 pb-4">
                <h3 className="font-bold text-sm text-slate-800 dark:text-slate-200">
                  Quick Universal Ingestion
                </h3>

                <div className="flex items-center gap-2">
                  <label htmlFor="quick-tool-select" className="text-xs text-slate-500">
                    Process with:
                  </label>
                  <select
                    id="quick-tool-select"
                    value={selectedQuickTool}
                    onChange={(e) => setSelectedQuickTool(e.target.value as ToolType)}
                    className="text-xs font-semibold px-2.5 py-1.5 rounded-full border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-brand-400"
                  >
                    {TOOLS.filter((t) => !NON_PDF_INPUT_TOOLS.has(t.id)).map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.title}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <Dropzone
                multiple={true}
                onFilesAccepted={handleGlobalFilesAccepted}
                title="Drop PDF documents to begin"
                subtitle="Instant client-side preflight and processing"
              />
            </div>

            {/* Tool Catalog Section */}
            <div className="space-y-5">
              <h2 className="text-lg font-bold text-slate-900 dark:text-white">
                {category === 'all' ? 'All Tools' : CATEGORIES.find((c) => c.id === category)?.label}
              </h2>

              {filteredTools.length === 0 ? (
                <p className="text-sm text-slate-500 dark:text-slate-400 py-8 text-center">
                  No tools in this category yet.
                </p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                  {filteredTools.map((tool) => (
                    <ToolCard key={tool.id} tool={tool} onSelect={handleToolSelect} />
                  ))}
                </div>
              )}
            </div>

            {/* Privacy Architecture Guarantee Section */}
            <div className="pt-4">
              <PrivacyBadge variant="detailed" />
            </div>
          </div>
        )}
      </main>

      <Footer />
    </div>
  );
}

export default App;
