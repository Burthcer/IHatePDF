import React, { useEffect, useState } from 'react';
import { X, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { usePdfRenderer } from '../../hooks/usePdfRenderer';

interface PagePreviewModalProps {
  pdfBuffer: ArrayBuffer;
  pageNumber: number; // 1-based, used for the "Page X of Y" label and nav range
  totalPages: number;
  renderPageNumber?: number; // actual source PDF page to rasterize, if it differs
  // from `pageNumber` (e.g. Organize shows position-in-sequence as the label
  // but must render the page's real, possibly-reordered, source page number)
  rotationDegrees?: number; // CSS-applied, for tools that preview a pending rotation
  accentColor?: string;
  onClose: () => void;
  onNavigate?: (pageNumber: number) => void; // omit to hide prev/next
}

// Wide enough for a genuinely sharp full-screen view on high-DPI displays,
// capped so a huge monitor doesn't force rendering an absurdly large canvas.
const TARGET_WIDTH = Math.min(2400, Math.floor((typeof window !== 'undefined' ? window.innerWidth : 1400) * (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1) * 0.9));

export const PagePreviewModal: React.FC<PagePreviewModalProps> = ({
  pdfBuffer,
  pageNumber,
  totalPages,
  renderPageNumber,
  rotationDegrees = 0,
  accentColor = '#E53E3E',
  onClose,
  onNavigate,
}) => {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const actualPageNumber = renderPageNumber ?? pageNumber;

  const { renderThumbnail } = usePdfRenderer();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    renderThumbnail(pdfBuffer, actualPageNumber, TARGET_WIDTH)
      .then((url) => {
        if (!cancelled) {
          setDataUrl(url);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pdfBuffer, actualPageNumber, renderThumbnail]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft' && onNavigate && pageNumber > 1) onNavigate(pageNumber - 1);
      if (e.key === 'ArrowRight' && onNavigate && pageNumber < totalPages) onNavigate(pageNumber + 1);
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose, onNavigate, pageNumber, totalPages]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/85 flex flex-col items-center justify-center p-4 sm:p-8"
      onClick={onClose}
    >
      <div className="absolute top-4 right-4 flex items-center gap-3">
        <span className="text-xs font-semibold text-white/70">
          Page {pageNumber} of {totalPages}
        </span>
        <button
          onClick={onClose}
          className="p-2 rounded-lg bg-white/10 hover:bg-white/20 text-white transition-colors"
          title="Close (Esc)"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {onNavigate && pageNumber > 1 && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onNavigate(pageNumber - 1);
          }}
          className="absolute left-2 sm:left-6 top-1/2 -translate-y-1/2 p-2.5 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
          title="Previous page"
        >
          <ChevronLeft className="w-6 h-6" />
        </button>
      )}
      {onNavigate && pageNumber < totalPages && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onNavigate(pageNumber + 1);
          }}
          className="absolute right-2 sm:right-6 top-1/2 -translate-y-1/2 p-2.5 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
          title="Next page"
        >
          <ChevronRight className="w-6 h-6" />
        </button>
      )}

      <div className="max-w-full max-h-full flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
        {loading ? (
          <Loader2 className="w-10 h-10 text-white/70 animate-spin" />
        ) : dataUrl ? (
          <img
            src={dataUrl}
            alt={`Page ${pageNumber}, full quality`}
            className="max-w-full max-h-[85vh] object-contain rounded shadow-2xl transition-transform duration-300"
            style={{ transform: rotationDegrees ? `rotate(${rotationDegrees}deg)` : undefined, boxShadow: `0 0 0 1px ${accentColor}33` }}
          />
        ) : (
          <p className="text-white/70 text-sm">Couldn't render this page.</p>
        )}
      </div>
    </div>
  );
};
