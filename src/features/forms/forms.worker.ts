/**
 * PDF Forms Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Reads and fills AcroForm fields with pdf-lib's form API. Hardened for
 * real-world forms: XFA wrappers (which make most viewers ignore the
 * AcroForm) are removed on fill, each field is set independently so one
 * odd field can't sink the rest, and appearances are regenerated with a
 * Unicode-capable font when the values need one.
 */

import { PDFCheckBox, PDFDocument, PDFDropdown, PDFOptionList, PDFRadioGroup, PDFTextField, PDFName, PDFRef } from 'pdf-lib';
import { openPdf } from '../../services/pdfLoader';
import { fontForText } from '../../services/fonts';
import type {
  WorkerRequest,
  GetFormFieldsPayload,
  GetFormFieldsResult,
  FillFormPayload,
  FormFieldInfo,
  ProcessedPdfResult,
  WorkerIncomingMessage,
} from '../../types/worker';

function hasXfa(doc: PDFDocument): boolean {
  const acro = doc.catalog.lookup(PDFName.of('AcroForm'));
  return !!(acro && 'lookup' in acro && (acro as { lookup: (n: PDFName) => unknown }).lookup(PDFName.of('XFA')));
}

export function describeFields(pdfDoc: PDFDocument): FormFieldInfo[] {
  const form = pdfDoc.getForm();
  const pageOf = new Map<string, number>();
  pdfDoc.getPages().forEach((page, i) => {
    page.node.Annots()?.asArray().forEach((ref) => {
      if (ref instanceof PDFRef) pageOf.set(ref.toString(), i + 1);
    });
  });
  const out: FormFieldInfo[] = [];
  for (const field of form.getFields()) {
    try {
      const name = field.getName();
      const widgetRef = field.acroField.getWidgets().map((w) => pdfDoc.context.getObjectRef(w.dict)).find(Boolean);
      const page = widgetRef ? pageOf.get(widgetRef.toString()) : undefined;
      const readOnly = field.isReadOnly();
      if (field instanceof PDFTextField) {
        out.push({ name, type: 'text', value: field.getText() ?? '', readOnly, multiline: field.isMultiline(), maxLength: field.getMaxLength(), page });
      } else if (field instanceof PDFCheckBox) {
        out.push({ name, type: 'checkbox', value: field.isChecked(), readOnly, page });
      } else if (field instanceof PDFRadioGroup) {
        out.push({ name, type: 'radio', options: field.getOptions(), value: field.getSelected() ?? '', readOnly, page });
      } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
        out.push({ name, type: 'dropdown', options: field.getOptions(), value: field.getSelected()[0] ?? '', readOnly, page });
      } else {
        out.push({ name, type: 'unsupported', readOnly, page });
      }
    } catch {
      // unreadable field — skip it
    }
  }
  return out.sort((a, b) => (a.page ?? 0) - (b.page ?? 0));
}

export async function fillForm(payload: FillFormPayload, onProgress?: (p: number, s: string) => void): Promise<ProcessedPdfResult> {
  const { fileBuffer, fileName, values, flatten } = payload;
  onProgress?.(20, 'Loading document...');
  const pdfDoc = await openPdf(fileBuffer);
  const form = pdfDoc.getForm();
  if (hasXfa(pdfDoc)) form.deleteXFA();

  onProgress?.(50, 'Filling fields...');
  const failed: string[] = [];
  for (const field of form.getFields()) {
    const name = field.getName();
    if (!(name in values)) continue;
    const value = values[name];
    try {
      if (field instanceof PDFTextField && typeof value === 'string') {
        const max = field.getMaxLength();
        field.setText(max !== undefined ? value.slice(0, max) : value);
      } else if (field instanceof PDFCheckBox && typeof value === 'boolean') {
        if (value) field.check();
        else field.uncheck();
      } else if (field instanceof PDFRadioGroup && typeof value === 'string') {
        if (value && field.getOptions().includes(value)) field.select(value);
        else if (!value) field.clear();
      } else if ((field instanceof PDFDropdown || field instanceof PDFOptionList) && typeof value === 'string') {
        if (value) field.select(value);
        else field.clear();
      }
    } catch {
      failed.push(name);
    }
  }

  const allText = Object.values(values).filter((v): v is string => typeof v === 'string').join(' ');
  const font = await fontForText(pdfDoc, { family: 'sans', bold: false, italic: false }, allText || 'a');
  try {
    form.updateFieldAppearances(font);
  } catch {
    // leave existing appearances; viewers regenerate them from values
  }

  if (flatten) {
    onProgress?.(75, 'Flattening form...');
    try {
      form.flatten({ updateFieldAppearances: false });
    } catch (err) {
      throw new Error(`The form couldn't be flattened (${err instanceof Error ? err.message : String(err)}). Try again with flattening turned off.`);
    }
  }

  onProgress?.(90, 'Saving PDF...');
  const bytes = await pdfDoc.save({ useObjectStreams: true });
  const resultBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  onProgress?.(100, 'Done.');
  return {
    fileName: `${fileName.replace(/\.[^/.]+$/, '')}_filled.pdf`,
    buffer: resultBuffer,
    size: resultBuffer.byteLength,
    pageCount: pdfDoc.getPageCount(),
    note: failed.length ? `Couldn't set: ${failed.join(', ')}` : undefined,
  };
}

if (typeof self !== 'undefined' && typeof (self as any).addEventListener === 'function') {
  self.addEventListener('message', async (event: MessageEvent<WorkerRequest<unknown>>) => {
    const { id, action, payload } = event.data;
    const progress = (p: number, stage: string) => {
      const msg: WorkerIncomingMessage = { type: 'PROGRESS', payload: { id, progress: p, stage } };
      self.postMessage(msg);
    };
    try {
      if (action === 'GET_FORM_FIELDS') {
        const { fileBuffer } = payload as GetFormFieldsPayload;
        progress(30, 'Detecting form fields...');
        const doc = await openPdf(fileBuffer);
        const result: GetFormFieldsResult = { fields: describeFields(doc), hadXfa: hasXfa(doc) };
        self.postMessage({ type: 'RESPONSE', payload: { id, success: true, data: result } });
      } else if (action === 'FILL_FORM') {
        const result = await fillForm(payload as FillFormPayload, progress);
        (self as any).postMessage({ type: 'RESPONSE', payload: { id, success: true, data: result } }, [result.buffer]);
      }
    } catch (err) {
      self.postMessage({ type: 'RESPONSE', payload: { id, success: false, error: err instanceof Error ? err.message : 'Form operation failed' } });
    }
  });
}
