/**
 * Core PDF domain interfaces and data types
 * IHatePDF - 100% Client-Side Architecture
 */

export interface PDFFile {
  id: string;
  name: string;
  size: number;
  pageCount: number;
  rawBuffer: ArrayBuffer;
  previewUrls: string[];
  /** The file was password-protected and has been decrypted on the way in. */
  wasProtected?: boolean;
  /** Still encrypted (only for tools that handle encryption themselves). */
  encrypted?: boolean;
}

export interface PDFPagePreview {
  pageNumber: number;
  dataUrl: string;
  width: number;
  height: number;
  rotation: number;
}

export type ToolType =
  | 'merge'
  | 'split'
  | 'rotate'
  | 'organize'
  | 'crop'
  | 'compress'
  | 'protect'
  | 'unlock'
  | 'watermark'
  | 'pageNumbers'
  | 'pdfToWord'
  | 'wordToPdf'
  | 'pdfToPpt'
  | 'pptToPdf'
  | 'pdfToJpg'
  | 'imageToPdf'
  | 'pdfToMarkdown'
  | 'repair'
  | 'pdfToExcel'
  | 'excelToPdf'
  | 'pdfToPdfa'
  | 'forms'
  | 'sign'
  | 'htmlToPdf'
  | 'redact'
  | 'compare'
  | 'scanToPdf'
  | 'editPdf';

export type ToolCategory = 'organize' | 'edit' | 'convertTo' | 'convertFrom' | 'optimize' | 'security';

export interface ToolMetadata {
  id: ToolType;
  title: string;
  description: string;
  icon: string;
  color: string;
  category: ToolCategory;
  badge?: string;
  acceptedFiles: 'single' | 'multiple';
  /** What the tool takes as input; non-PDF tools can't receive dropped PDFs. */
  input?: 'pdf' | 'other';
  keywords?: string;
}
