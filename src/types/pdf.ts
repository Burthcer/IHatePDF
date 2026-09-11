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
  | 'editPdf'
  | 'ocr';

export type ToolCategory = 'organize' | 'optimize' | 'convert' | 'edit' | 'security';

export interface ToolMetadata {
  id: ToolType;
  title: string;
  description: string;
  icon: string;
  color: string;
  category: ToolCategory;
  badge?: string;
  acceptedFiles: 'single' | 'multiple';
}
