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
    buffer: ArrayBuffer;
  }>;
}

export interface SplitPayload {
  fileBuffer: ArrayBuffer;
  fileName: string;
  ranges: Array<{ from: number; to: number }> | 'all';
}

export interface RotatePayload {
  fileBuffer: ArrayBuffer;
  fileName: string;
  rotations: Array<{ pageIndex: number; degrees: number }>; // degrees: 90, 180, 270
  globalDegrees?: number;
}

export interface OrganizePayload {
  fileBuffer: ArrayBuffer;
  fileName: string;
  pageOrder: number[]; // 0-based page indices in new desired order
  deletedPages?: number[];
}

export interface CompressPayload {
  fileBuffer: ArrayBuffer;
  fileName: string;
  level: 'low' | 'recommended' | 'extreme';
}

export interface ProtectPayload {
  fileBuffer: ArrayBuffer;
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
  fileBuffer: ArrayBuffer;
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
  fileBuffer: ArrayBuffer;
  fileName: string;
  margins: CropMarginsMm;
  pageIndices?: number[]; // 0-based; omit/undefined = apply to every page
}

export type WatermarkPosition =
  | 'top-left' | 'top-center' | 'top-right'
  | 'center-left' | 'center' | 'center-right'
  | 'bottom-left' | 'bottom-center' | 'bottom-right';

export interface WatermarkPayload {
  fileBuffer: ArrayBuffer;
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
}

export type PageNumberFormat = 'n' | 'n_of_total' | 'roman';

export interface PageNumbersPayload {
  fileBuffer: ArrayBuffer;
  fileName: string;
  format: PageNumberFormat;
  position: WatermarkPosition;
  fontSize: number;
  color: string;
  marginMm: number;
  startPage: number; // 1-based, inclusive
  endPage?: number; // 1-based, inclusive; omit = last page
  startingNumber: number;
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

export interface BuildPptxPayload {
  slides: PptxSlideImage[];
  pageText?: PositionedPageText[];
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
  images: RenderedPageImage[];
  fileName: string;
}

export type ImagePageOrientation = 'portrait' | 'landscape' | 'auto';
export type ImagePageMargin = 'none' | 'small' | 'big';
export type ImagePageSize = 'a4' | 'letter' | 'fit';

export interface ImagesToPdfPayload {
  images: Array<{ bytes: ArrayBuffer; type: 'png' | 'jpg' }>;
  orientation: ImagePageOrientation;
  margin: ImagePageMargin;
  pageSize: ImagePageSize;
  fileName: string;
}

export interface PdfToMarkdownPayload {
  pages: ExtractedPageText[];
  fileName: string;
}

export interface RepairPayload {
  fileBuffer: ArrayBuffer;
  fileName: string;
}

/** One extracted table row (cells) for PDF -> Excel. */
export interface PdfToXlsxPayload {
  pages: Array<{ pageNumber: number; rows: string[][] }>;
  fileName: string;
}

export interface XlsxToPdfPayload {
  fileBuffer: ArrayBuffer;
  fileName: string;
}

export interface PdfToPdfaPayload {
  fileBuffer: ArrayBuffer;
  fileName: string;
}

export type FormFieldType = 'text' | 'checkbox' | 'radio' | 'dropdown' | 'unsupported';

export interface FormFieldInfo {
  name: string;
  type: FormFieldType;
  options?: string[];
  value?: string | boolean;
}

export interface GetFormFieldsPayload {
  fileBuffer: ArrayBuffer;
}

export interface GetFormFieldsResult {
  fields: FormFieldInfo[];
}

export interface FillFormPayload {
  fileBuffer: ArrayBuffer;
  fileName: string;
  values: Record<string, string | boolean>;
  flatten: boolean;
}

export interface StampSignaturePayload {
  fileBuffer: ArrayBuffer;
  fileName: string;
  signatureImageBytes: ArrayBuffer;
  pageIndex: number; // 0-based
  xPt: number;
  yPt: number;
  widthPt: number;
  heightPt: number;
}

export interface HtmlBlock {
  type: 'h1' | 'h2' | 'h3' | 'p' | 'li';
  text: string;
  bold?: boolean;
  italic?: boolean;
}

export interface HtmlToPdfPayload {
  blocks: HtmlBlock[];
  fileName: string;
}

export interface RedactionBox {
  pageIndex: number; // 0-based
  xPt: number;
  yPt: number;
  widthPt: number;
  heightPt: number;
}

export interface RedactPdfPayload {
  pageImages: RenderedPageImage[]; // full-resolution render of every page
  pageSizesPt: Array<{ width: number; height: number }>;
  boxes: RedactionBox[];
  fileName: string;
}

export interface EditTextElement {
  type: 'text';
  pageIndex: number; // 0-based
  xPt: number; // baseline x
  yPt: number; // baseline y
  text: string;
  fontSize: number;
  color: string; // hex
  bold: boolean;
}

export interface EditImageElement {
  type: 'image';
  pageIndex: number; // 0-based
  xPt: number; // bottom-left x
  yPt: number; // bottom-left y
  widthPt: number;
  heightPt: number;
  imageBytes: ArrayBuffer;
  imageType: 'png' | 'jpg';
}

export type EditElement = EditTextElement | EditImageElement;

export interface EditPdfPayload {
  fileBuffer: ArrayBuffer;
  fileName: string;
  elements: EditElement[];
}

export interface ProcessedPdfResult {
  fileName: string;
  buffer: ArrayBuffer;
  size: number;
  pageCount?: number;
}

export interface SplitPdfResult {
  files: Array<{
    name: string;
    buffer: ArrayBuffer;
    size: number;
    pageCount: number;
  }>;
}
