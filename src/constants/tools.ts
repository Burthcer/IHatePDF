import type { ToolCategory, ToolMetadata, ToolType } from '../types/pdf';

/**
 * Single source of truth for the tool catalog. Views read their title and
 * description from here via `getTool(id)`.
 */
export const TOOLS: ToolMetadata[] = [
  // Organize
  { id: 'merge', title: 'Merge', description: 'Combine several PDFs into one, in the order you choose.', icon: 'Combine', color: '', category: 'organize', acceptedFiles: 'multiple', keywords: 'combine join append' },
  { id: 'split', title: 'Split', description: 'Pull out page ranges, or split into one file per page or every N pages.', icon: 'Scissors', color: '', category: 'organize', acceptedFiles: 'single', keywords: 'extract separate burst' },
  { id: 'organize', title: 'Organize pages', description: 'Reorder, duplicate, rotate or delete pages by dragging thumbnails.', icon: 'LayoutGrid', color: '', category: 'organize', acceptedFiles: 'single', keywords: 'reorder sort delete pages' },
  { id: 'rotate', title: 'Rotate', description: 'Turn some or all pages by 90° steps.', icon: 'RotateCw', color: '', category: 'organize', acceptedFiles: 'single', keywords: 'turn orientation landscape' },
  { id: 'crop', title: 'Crop', description: 'Trim page margins on selected pages or the whole document.', icon: 'Crop', color: '', category: 'organize', acceptedFiles: 'single', keywords: 'trim margins' },
  { id: 'compare', title: 'Compare', description: 'See what changed between two versions of a document.', icon: 'GitCompare', color: '', category: 'organize', acceptedFiles: 'multiple', input: 'other', keywords: 'diff difference versions' },

  // Edit
  { id: 'editPdf', title: 'Edit PDF', description: 'Change existing text like in a word processor, move images, add text, shapes and highlights.', icon: 'PenSquare', color: '', category: 'edit', acceptedFiles: 'single', keywords: 'modify change text typo word annotate whiteout' },
  { id: 'sign', title: 'Sign', description: 'Draw, type or upload a signature and place it on the page.', icon: 'PenLine', color: '', category: 'edit', acceptedFiles: 'single', keywords: 'signature autograph' },
  { id: 'forms', title: 'Fill forms', description: 'Fill in a PDF form’s fields and optionally flatten them.', icon: 'ListChecks', color: '', category: 'edit', acceptedFiles: 'single', keywords: 'acroform fields fill' },
  { id: 'watermark', title: 'Watermark', description: 'Stamp text or an image across pages, above or below the content.', icon: 'Stamp', color: '', category: 'edit', acceptedFiles: 'single', keywords: 'stamp draft confidential logo' },
  { id: 'pageNumbers', title: 'Page numbers', description: 'Number pages with your choice of position, style and starting value.', icon: 'Hash', color: '', category: 'edit', acceptedFiles: 'single', keywords: 'paginate numbering footer' },
  { id: 'redact', title: 'Redact', description: 'Black out text for good — by drawing boxes or searching for words.', icon: 'EyeOff', color: '', category: 'edit', acceptedFiles: 'single', keywords: 'black out censor hide remove sensitive' },

  // Convert to PDF
  { id: 'imageToPdf', title: 'Images to PDF', description: 'Turn JPG, PNG, WebP and other images into a PDF, one per page.', icon: 'ImagePlus', color: '', category: 'convertTo', acceptedFiles: 'multiple', input: 'other', keywords: 'jpg png photo picture' },
  { id: 'wordToPdf', title: 'Word to PDF', description: 'Convert a .docx document, keeping fonts, tables and styles.', icon: 'FileType', color: '', category: 'convertTo', acceptedFiles: 'single', input: 'other', keywords: 'docx doc microsoft word' },
  { id: 'excelToPdf', title: 'Excel to PDF', description: 'Convert spreadsheet sheets into paginated tables.', icon: 'FileSpreadsheet', color: '', category: 'convertTo', acceptedFiles: 'single', input: 'other', keywords: 'xlsx xls csv spreadsheet' },
  { id: 'pptToPdf', title: 'PowerPoint to PDF', description: 'Convert a .pptx deck, one slide per page.', icon: 'MonitorPlay', color: '', category: 'convertTo', acceptedFiles: 'single', input: 'other', keywords: 'pptx slides presentation' },
  { id: 'htmlToPdf', title: 'HTML to PDF', description: 'Lay out HTML with real styling into selectable, paginated PDF text.', icon: 'Code2', color: '', category: 'convertTo', acceptedFiles: 'single', input: 'other', keywords: 'web page html' },
  { id: 'scanToPdf', title: 'Scan to PDF', description: 'Photograph pages with your camera and save them as a PDF.', icon: 'Camera', color: '', category: 'convertTo', acceptedFiles: 'multiple', input: 'other', keywords: 'camera photo scanner' },

  // Convert from PDF
  { id: 'pdfToWord', title: 'PDF to Word', description: 'Get an editable .docx with paragraphs, headings and bold/italic text.', icon: 'FileText', color: '', category: 'convertFrom', acceptedFiles: 'single', keywords: 'docx doc microsoft word' },
  { id: 'pdfToExcel', title: 'PDF to Excel', description: 'Pull tables out of a PDF into a spreadsheet, one sheet per page.', icon: 'Table', color: '', category: 'convertFrom', acceptedFiles: 'single', keywords: 'xlsx spreadsheet table csv' },
  { id: 'pdfToPpt', title: 'PDF to PowerPoint', description: 'One slide per page, with the text as editable text boxes.', icon: 'Presentation', color: '', category: 'convertFrom', acceptedFiles: 'single', keywords: 'pptx slides' },
  { id: 'pdfToJpg', title: 'PDF to images', description: 'Export pages as JPG or PNG at the resolution you need.', icon: 'ImageIcon', color: '', category: 'convertFrom', acceptedFiles: 'single', keywords: 'jpg png image picture export' },
  { id: 'pdfToMarkdown', title: 'PDF to Markdown', description: 'Clean text with headings, lists and paragraphs — handy for notes and LLMs.', icon: 'FileCode', color: '', category: 'convertFrom', acceptedFiles: 'single', keywords: 'md text txt extract' },

  // Optimize
  { id: 'compress', title: 'Compress', description: 'Shrink the file by recompressing images and removing dead weight.', icon: 'Minimize2', color: '', category: 'optimize', acceptedFiles: 'single', keywords: 'reduce size smaller optimize' },
  { id: 'repair', title: 'Repair', description: 'Rebuild a damaged PDF and recover whatever pages can be read.', icon: 'Wrench', color: '', category: 'optimize', acceptedFiles: 'single', keywords: 'fix corrupt broken recover' },
  { id: 'pdfToPdfa', title: 'PDF to PDF/A', description: 'Prepare a document for long-term archiving (PDF/A-2b).', icon: 'Archive', color: '', category: 'optimize', acceptedFiles: 'single', keywords: 'archive pdfa iso 19005' },

  // Security
  { id: 'protect', title: 'Protect', description: 'Encrypt with AES-256 and a password, and restrict printing or copying.', icon: 'Lock', color: '', category: 'security', acceptedFiles: 'single', keywords: 'password encrypt lock' },
  { id: 'unlock', title: 'Unlock', description: 'Remove a password or printing/copying restrictions you’re allowed to remove.', icon: 'Unlock', color: '', category: 'security', acceptedFiles: 'single', keywords: 'decrypt remove password restrictions' },
];

export const CATEGORIES: Array<{ id: ToolCategory; label: string }> = [
  { id: 'edit', label: 'Edit' },
  { id: 'organize', label: 'Organize' },
  { id: 'convertFrom', label: 'Convert from PDF' },
  { id: 'convertTo', label: 'Convert to PDF' },
  { id: 'optimize', label: 'Optimize' },
  { id: 'security', label: 'Security' },
];

const BY_ID = new Map(TOOLS.map((t) => [t.id, t]));

export function getTool(id: ToolType): ToolMetadata {
  return BY_ID.get(id)!;
}

export function takesPdf(id: ToolType): boolean {
  return getTool(id)?.input !== 'other';
}
