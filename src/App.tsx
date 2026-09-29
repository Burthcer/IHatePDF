import React, { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { Spinner } from './components/ui';
import { Header } from './components/common/Header';
import { Footer } from './components/common/Footer';
import { SystemNotice } from './components/common/SystemNotice';
import { Home } from './components/home/Home';
import { memoryManager } from './services/memoryManager';
import { TOOLS, getTool, takesPdf } from './constants/tools';
import type { ToolType, PDFFile } from './types/pdf';

const MergeView = lazy(() => import('./features/merge/MergeView').then((m) => ({ default: m.MergeView })));
const SplitView = lazy(() => import('./features/split/SplitView').then((m) => ({ default: m.SplitView })));
const RotateView = lazy(() => import('./features/rotate/RotateView').then((m) => ({ default: m.RotateView })));
const OrganizeView = lazy(() => import('./features/organize/OrganizeView').then((m) => ({ default: m.OrganizeView })));
const CropView = lazy(() => import('./features/crop/CropView').then((m) => ({ default: m.CropView })));
const CompressView = lazy(() => import('./features/compress/CompressView').then((m) => ({ default: m.CompressView })));
const ProtectView = lazy(() => import('./features/protect/ProtectView').then((m) => ({ default: m.ProtectView })));
const UnlockView = lazy(() => import('./features/unlock/UnlockView').then((m) => ({ default: m.UnlockView })));
const WatermarkView = lazy(() => import('./features/watermark/WatermarkView').then((m) => ({ default: m.WatermarkView })));
const PageNumbersView = lazy(() => import('./features/pageNumbers/PageNumbersView').then((m) => ({ default: m.PageNumbersView })));
const PdfToWordView = lazy(() => import('./features/pdfToWord/PdfToWordView').then((m) => ({ default: m.PdfToWordView })));
const WordToPdfView = lazy(() => import('./features/wordToPdf/WordToPdfView').then((m) => ({ default: m.WordToPdfView })));
const PdfToPptView = lazy(() => import('./features/pdfToPpt/PdfToPptView').then((m) => ({ default: m.PdfToPptView })));
const PptToPdfView = lazy(() => import('./features/pptToPdf/PptToPdfView').then((m) => ({ default: m.PptToPdfView })));
const PdfToJpgView = lazy(() => import('./features/pdfToJpg/PdfToJpgView').then((m) => ({ default: m.PdfToJpgView })));
const ImageToPdfView = lazy(() => import('./features/imageToPdf/ImageToPdfView').then((m) => ({ default: m.ImageToPdfView })));
const PdfToMarkdownView = lazy(() => import('./features/pdfToMarkdown/PdfToMarkdownView').then((m) => ({ default: m.PdfToMarkdownView })));
const RepairView = lazy(() => import('./features/repair/RepairView').then((m) => ({ default: m.RepairView })));
const FormsView = lazy(() => import('./features/forms/FormsView').then((m) => ({ default: m.FormsView })));
const SignView = lazy(() => import('./features/sign/SignView').then((m) => ({ default: m.SignView })));
const PdfToPdfaView = lazy(() => import('./features/pdfToPdfa/PdfToPdfaView').then((m) => ({ default: m.PdfToPdfaView })));
const PdfToExcelView = lazy(() => import('./features/pdfToExcel/PdfToExcelView').then((m) => ({ default: m.PdfToExcelView })));
const ExcelToPdfView = lazy(() => import('./features/excelToPdf/ExcelToPdfView').then((m) => ({ default: m.ExcelToPdfView })));
const CompareView = lazy(() => import('./features/compare/CompareView').then((m) => ({ default: m.CompareView })));
const ScanToPdfView = lazy(() => import('./features/scanToPdf/ScanToPdfView').then((m) => ({ default: m.ScanToPdfView })));
const EditPdfView = lazy(() => import('./features/editPdf/EditPdfView').then((m) => ({ default: m.EditPdfView })));
const HtmlToPdfView = lazy(() => import('./features/htmlToPdf/HtmlToPdfView').then((m) => ({ default: m.HtmlToPdfView })));
const ShareView = lazy(() => import('./features/share/ShareView').then((m) => ({ default: m.ShareView })));
const RedactView = lazy(() => import('./features/redact/RedactView').then((m) => ({ default: m.RedactView })));

type ToolViewProps = { initialFiles?: PDFFile[]; onBack: () => void };

const VIEWS: Record<ToolType, React.ComponentType<ToolViewProps>> = {
  merge: MergeView,
  split: SplitView,
  rotate: RotateView,
  organize: OrganizeView,
  crop: CropView,
  compress: CompressView,
  protect: ProtectView,
  unlock: UnlockView,
  watermark: WatermarkView,
  pageNumbers: PageNumbersView,
  pdfToWord: PdfToWordView,
  wordToPdf: WordToPdfView,
  pdfToPpt: PdfToPptView,
  pptToPdf: PptToPdfView,
  pdfToJpg: PdfToJpgView,
  imageToPdf: ImageToPdfView,
  pdfToMarkdown: PdfToMarkdownView,
  repair: RepairView,
  forms: FormsView,
  sign: SignView,
  pdfToPdfa: PdfToPdfaView,
  pdfToExcel: PdfToExcelView,
  excelToPdf: ExcelToPdfView,
  compare: CompareView,
  scanToPdf: ScanToPdfView,
  editPdf: EditPdfView,
  htmlToPdf: HtmlToPdfView,
  redact: RedactView,
  share: ShareView,
};

function toolFromHash(): ToolType | null {
  const id = window.location.hash.replace(/^#\/?/, '');
  return TOOLS.some((t) => t.id === id) ? (id as ToolType) : null;
}

export function App() {
  const [activeTool, setActiveTool] = useState<ToolType | null>(toolFromHash);
  const [files, setFiles] = useState<PDFFile[]>([]);
  // Remount the tool when it's reopened so it starts from a clean slate.
  const [session, setSession] = useState(0);

  useEffect(() => {
    const onHash = () => {
      const next = toolFromHash();
      setActiveTool((prev) => {
        if (prev !== next) {
          memoryManager.revokeAllUrls();
          setFiles([]);
          setSession((s) => s + 1);
        }
        return next;
      });
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    document.title = activeTool ? `${getTool(activeTool).title} · IHatePDF` : 'IHatePDF — PDF tools that stay on your computer';
    window.scrollTo({ top: 0 });
  }, [activeTool]);

  const openTool = useCallback((id: ToolType, withFiles?: PDFFile[]) => {
    setFiles(withFiles && takesPdf(id) ? withFiles : []);
    setSession((s) => s + 1);
    setActiveTool(id);
    if (window.location.hash !== `#/${id}`) window.history.pushState(null, '', `#/${id}`);
  }, []);

  const goHome = useCallback(() => {
    memoryManager.revokeAllUrls();
    setFiles([]);
    setActiveTool(null);
    if (window.location.hash) window.history.pushState(null, '', window.location.pathname + window.location.search);
  }, []);

  const View = activeTool ? VIEWS[activeTool] : null;

  return (
    <div className="min-h-screen flex flex-col">
      <Header onHome={goHome} />
      <SystemNotice />
      <main className="flex-1">
        {View ? (
          <Suspense
            fallback={
              <div className="flex items-center justify-center gap-2 py-24 text-sm text-muted">
                <Spinner /> Loading tool…
              </div>
            }
          >
            <View key={`${activeTool}-${session}`} initialFiles={files} onBack={goHome} />
          </Suspense>
        ) : (
          <Home onOpenTool={openTool} />
        )}
      </main>
      {activeTool !== 'editPdf' && <Footer />}
    </div>
  );
}

export default App;
