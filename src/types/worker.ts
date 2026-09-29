/**
 * Web Worker RPC Protocol Types & Message Envelopes
 * IHatePDF - 100% Client-Side Architecture
 */

export type WorkerAction =
  | 'MERGE_PDFS'
  | 'SPLIT_PDF'
  | 'ROTATE_PAGES'
  | 'ORGANIZE_PAGES'
  | 'CROP_PAGES'
  | 'COMPRESS_PDF'
  | 'PROTECT_PDF'
  | 'UNLOCK_PDF'
  | 'WATERMARK_PDF'
  | 'ADD_PAGE_NUMBERS'
  | 'RENDER_PAGES'
  | 'EXTRACT_METADATA'
  | 'PDF_TO_WORD'
  | 'WORD_TO_PDF'
  | 'BUILD_PPTX'
  | 'PPT_TO_PDF'
  | 'BUILD_JPG_ZIP'
  | 'IMAGES_TO_PDF'
  | 'PDF_TO_MARKDOWN'
  | 'REPAIR_PDF'
  | 'PDF_TO_XLSX'
  | 'XLSX_TO_PDF'
  | 'PDF_TO_PDFA'
  | 'FILL_FORM'
  | 'GET_FORM_FIELDS'
  | 'STAMP_SIGNATURE'
  | 'HTML_TO_PDF'
  | 'REDACT_PDF'
  | 'EDIT_PDF';

export interface WorkerRequest<T = unknown> {
  id: string;
  action: WorkerAction | string;
  payload: T;
}

export interface WorkerResponse<T = unknown> {
  id: string;
  success: boolean;
  data?: T;
  error?: string;
}

export interface WorkerProgressPayload {
  id: string;
  progress: number; // 0 to 100
  stage: string;
}

export interface WorkerProgressMessage {
  type: 'PROGRESS';
  payload: WorkerProgressPayload;
}

export interface WorkerResponseMessage<T = unknown> {
  type: 'RESPONSE';
  payload: WorkerResponse<T>;
}

export type WorkerIncomingMessage<T = unknown> = WorkerProgressMessage | WorkerResponseMessage<T>;

/* Action-Specific Payload Definitions */

export interface MergePayload {
  files: Array<{
    name: string;
    buffer: PdfInput;
  }>;
  outputName?: string;
}

export interface SplitPayload {
  fileBuffer: PdfInput;
  fileName: string;
  ranges: Array<{ from: number; to: number }> | 'all';
  /** One output file per group of 0-based page indices (ZIP when more than one). */
  groups?: number[][];
}

export interface RotatePayload {
  fileBuffer: PdfInput;
  fileName: string;
  rotations: Array<{ pageIndex: number; degrees: number }>; // degrees: 90, 180, 270
  globalDegrees?: number;
}

export interface OrganizePayload {
  fileBuffer: PdfInput;
  fileName: string;
  pageOrder: number[]; // 0-based page indices in new desired order; -1 = blank page
  deletedPages?: number[];
  rotations?: number[]; // degrees to add, per output page
}

export interface CompressPayload {
  fileBuffer: PdfInput;
  fileName: string;
  level: 'low' | 'recommended' | 'extreme' | 'custom';
  /** For level 'custom': the size the output should fit in, in bytes. */
  targetBytes?: number;
}

export interface ProtectPayload {
  fileBuffer: PdfInput;
  fileName: string;
  userPassword?: string;
  ownerPassword?: string;
  permissions?: {
    printing?: boolean;
    modifying?: boolean;
    copying?: boolean;
    annotating?: boolean;
  };
}

export interface UnlockPayload {
  fileBuffer: PdfInput;
  fileName: string;
  password?: string;
}

export interface CropMarginsMm {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface CropPayload {
  fileBuffer: PdfInput;
  fileName: string;
  margins: CropMarginsMm;
  pageIndices?: number[]; // 0-based; omit/undefined = apply to every page
}

export type WatermarkPosition =
  | 'top-left' | 'top-center' | 'top-right'
  | 'center-left' | 'center' | 'center-right'
  | 'bottom-left' | 'bottom-center' | 'bottom-right';

export interface WatermarkPayload {
  fileBuffer: PdfInput;
  fileName: string;
  mode: 'text' | 'image';
  text?: string;
  imageBytes?: ArrayBuffer;
  imageType?: 'png' | 'jpg';
  fontSize: number;
  color: string; // hex, e.g. "#E53E3E"
  opacity: number; // 0-1
  rotationDegrees: number;
  position: WatermarkPosition;
  layer: 'above' | 'below';
  /** Repeat across the whole page instead of one stamp. */
  tile?: boolean;
  /** Page range string ("1-3, 5"); omit for all pages. */
  pages?: string;
  fontFamily?: 'sans' | 'serif' | 'mono';
  bold?: boolean;
  /** Image width as a fraction of the page width. */
  imageScale?: number;
}

export type PageNumberFormat = 'n' | 'n_of_total' | 'roman';

export interface PageNumbersPayload {
  fileBuffer: PdfInput;
  fileName: string;
  format: PageNumberFormat;
  position: WatermarkPosition;
  fontSize: number;
  color: string;
  marginMm: number;
  startPage: number; // 1-based, inclusive
  endPage?: number; // 1-based, inclusive; omit = last page
  startingNumber: number;
  /** Free-form template: {n} = number, {total} = page count. Overrides `format` when set. */
  template?: string;
  /** Mirror left/right positions on even pages (for double-sided printing). */
  mirror?: boolean;
}

/** One page's extracted text, grouped into paragraphs by vertical gaps. */
export interface ExtractedPageText {
  pageNumber: number;
  paragraphs: string[];
}

export interface StyledParagraph {
  text: string;
  fontSizePt: number;
}

export interface StyledPageText {
  pageNumber: number;
  paragraphs: StyledParagraph[];
}

export interface PdfToWordPayload {
  pages: StyledPageText[];
  fileName: string;
  layout?: import('../services/textLayout').PageLayout[];
  pageBreaks?: boolean;
}

export interface WordToPdfPayload {
  fileBuffer: ArrayBuffer;
  fileName: string;
}

/** One rendered slide image (PNG data URL) for PDF -> PPTX. */
export interface PptxSlideImage {
  dataUrl: string;
  widthPt: number;
  heightPt: number;
}

export interface PositionedTextItem {
  text: string;
  xPt: number;
  yPt: number;
  fontSizePt: number;
}

export interface PositionedPageText {
  pageNumber: number;
  widthPt: number;
  heightPt: number;
  items: PositionedTextItem[];
}

export interface PptTextBox {
  x: number;
  y: number;
  width: number;
  height: number;
  lines: string[];
  fontSize: number;
  color: string;
  bold: boolean;
  italic: boolean;
  fontFace: string;
  align: 'left' | 'center' | 'right';
  lineHeight?: number;
  rotate?: number;
}

export interface BuildPptxPayload {
  slides: PptxSlideImage[];
  pageText?: PositionedPageText[];
  /** Styled paragraphs per slide (preferred over pageText). */
  textBoxes?: PptTextBox[][];
  fileName: string;
}

export interface PptToPdfPayload {
  fileBuffer: ArrayBuffer;
  fileName: string;
}

export interface OfficeConversionResult {
  fileName: string;
  buffer: ArrayBuffer;
  size: number;
  mimeType: string;
  pageCount?: number;
}

/** One rendered page image (data URL) for PDF -> JPG. */
export interface RenderedPageImage {
  pageNumber: number;
  dataUrl: string;
}

export interface BuildJpgZipPayload {
  images: Array<RenderedPageImage | { pageNumber: number; bytes: Blob | ArrayBuffer; dataUrl?: undefined }>;
  fileName: string;
  /** File extension for the images (default jpg). */
  ext?: 'jpg' | 'png';
}

export type ImagePageOrientation = 'portrait' | 'landscape' | 'auto';
export type ImagePageMargin = 'none' | 'small' | 'big';
export type ImagePageSize = 'a4' | 'letter' | 'fit';

export interface ImagesToPdfPayload {
  images: Array<{ bytes: Blob | ArrayBuffer; type: 'png' | 'jpg' }>;
  orientation: ImagePageOrientation;
  margin: ImagePageMargin;
  pageSize: ImagePageSize;
  fileName: string;
}

export interface RepairPayload {
  fileBuffer: PdfInput;
  fileName: string;
  /** Fallback: rebuild from pages pdf.js could still render. */
  renderedPages?: Array<{ jpeg: Blob | ArrayBuffer; widthPt: number; heightPt: number }>;
}

/** One extracted table row (cells) for PDF -> Excel. */
export interface PdfToXlsxPayload {
  pages: Array<{ pageNumber: number; rows: string[][] }>;
  fileName: string;
  singleSheet?: boolean;
}

export interface XlsxToPdfPayload {
  fileBuffer: ArrayBuffer;
  fileName: string;
}

export interface PdfToPdfaPayload {
  fileBuffer: PdfInput;
  fileName: string;
}

export type FormFieldType = 'text' | 'checkbox' | 'radio' | 'dropdown' | 'unsupported';

export interface FormFieldInfo {
  name: string;
  type: FormFieldType;
  options?: string[];
  value?: string | boolean;
  readOnly?: boolean;
  multiline?: boolean;
  maxLength?: number;
  /** 1-based page the field's first widget sits on, when known. */
  page?: number;
}

export interface GetFormFieldsPayload {
  fileBuffer: PdfInput;
}

export interface GetFormFieldsResult {
  fields: FormFieldInfo[];
  hadXfa?: boolean;
}

export interface FillFormPayload {
  fileBuffer: PdfInput;
  fileName: string;
  values: Record<string, string | boolean>;
  flatten: boolean;
}

export interface SignaturePlacement {
  pageIndex: number; // 0-based
  /** Viewer-space box (points, origin top-left of the page as displayed). */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StampSignaturePayload {
  fileBuffer: PdfInput;
  fileName: string;
  signatureImageBytes: ArrayBuffer;
  placements: SignaturePlacement[];
}

export type HtmlDisplayItem =
  | { t: 'text'; x: number; y: number; text: string; size: number; family: 'sans' | 'serif' | 'mono'; bold: boolean; italic: boolean; color: string }
  | { t: 'rect'; x: number; y: number; w: number; h: number; fill: string; opacity: number }
  | { t: 'line'; x1: number; y1: number; x2: number; y2: number; width: number; color: string; dashed: boolean }
  | { t: 'image'; x: number; y: number; w: number; h: number; index: number };

/** One output page: items in points, origin top-left of the page. */
export interface HtmlPage {
  items: HtmlDisplayItem[];
}

export interface HtmlToPdfPayload {
  pages: HtmlPage[];
  images: ArrayBuffer[];
  pageWidthPt: number;
  pageHeightPt: number;
  fileName: string;
  title?: string;
}

/** A redacted page rendered by the page for the Redact worker (JPEG, pixel size). */
export interface RedactedPageRender {
  jpeg: ArrayBuffer;
  width: number;
  height: number;
}

export interface RedactionBox {
  pageIndex: number; // 0-based
  /** Viewer-space box in points (origin top-left of the page as displayed). */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RedactPdfPayload {
  fileBuffer: PdfInput;
  fileName: string;
  /** Pages rebuilt from redacted renders; every other page is copied untouched. */
  /**
   * Pages rebuilt from redacted renders. Without `jpeg`, the worker asks the
   * page for each render ('redacted-page') only when it writes that page, so
   * just one exists at a time.
   */
  pages: Array<{ pageIndex: number; jpeg?: Blob | ArrayBuffer; widthPt: number; heightPt: number }>;
  stripMetadata: boolean;
}

/**
 * A tool's output file. Big outputs are streamed out of the worker as they're
 * written ('stream', resolved by the page into 'file' — a temp file on disk
 * in the desktop app — or 'blob' in a browser), so they never sit in memory whole.
 */
export type ToolOutput =
  | { kind: 'stream'; id: string; size: number }
  | { kind: 'file'; path: string; size: number }
  | { kind: 'blob'; blob: Blob; size: number };

/** A PDF handed to a worker: a (disk-backed) Blob, or bytes. */
export type PdfInput = ArrayBuffer | Blob;

export interface ProcessedPdfResult {
  fileName: string;
  /** In-memory result (small outputs, tests). */
  buffer?: ArrayBuffer;
  /** Streamed result (the app). */
  output?: ToolOutput;
  size: number;
  pageCount?: number;
  /** Human-readable summary of what the tool did (shown with the result). */
  note?: string;
}

export interface SplitPdfResult {
  files: Array<{
    name: string;
    buffer: ArrayBuffer;
    size: number;
    pageCount: number;
  }>;
}
