/**
 * PDF Forms Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Detects and fills AcroForm fields using pdf-lib's native form API — no
 * custom PDF parsing needed for this one, pdf-lib already understands the
 * field dictionary structure.
 */

import {
  PDFDocument,
  PDFTextField,
  PDFCheckBox,
  PDFRadioGroup,
  PDFDropdown,
  PDFOptionList,
} from 'pdf-lib';
import type {
  WorkerRequest,
  GetFormFieldsPayload,
  GetFormFieldsResult,
  FillFormPayload,
  FormFieldInfo,
  ProcessedPdfResult,
  WorkerIncomingMessage,
} from '../../types/worker';

function describeFields(pdfDoc: PDFDocument): FormFieldInfo[] {
  const form = pdfDoc.getForm();
  return form.getFields().map((field) => {
    const name = field.getName();
    if (field instanceof PDFTextField) {
      return { name, type: 'text', value: field.getText() || '' };
    }
    if (field instanceof PDFCheckBox) {
      return { name, type: 'checkbox', value: field.isChecked() };
    }
    if (field instanceof PDFRadioGroup) {
      return { name, type: 'radio', options: field.getOptions(), value: field.getSelected() || '' };
    }
    if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
      return { name, type: 'dropdown', options: field.getOptions(), value: field.getSelected()[0] || '' };
    }
    return { name, type: 'unsupported' };
  });
}

self.addEventListener('message', async (event: MessageEvent<WorkerRequest<unknown>>) => {
  const { id, action, payload } = event.data;

  const emitProgress = (progress: number, stage: string) => {
    const msg: WorkerIncomingMessage = { type: 'PROGRESS', payload: { id, progress, stage } };
    self.postMessage(msg);
  };
  const respond = (data: unknown) => {
    const responseMsg: WorkerIncomingMessage = { type: 'RESPONSE', payload: { id, success: true, data } };
    self.postMessage(responseMsg);
  };
  const respondFail = (err: unknown) => {
    const errorMsg = err instanceof Error ? err.message : 'Form operation failed';
    const responseMsg: WorkerIncomingMessage = { type: 'RESPONSE', payload: { id, success: false, error: errorMsg } };
    self.postMessage(responseMsg);
  };

  try {
    if (action === 'GET_FORM_FIELDS') {
      const { fileBuffer } = payload as GetFormFieldsPayload;
      emitProgress(30, 'Detecting form fields...');
      const pdfDoc = await PDFDocument.load(fileBuffer);
      const fields = describeFields(pdfDoc);
      emitProgress(100, 'Done.');
      const result: GetFormFieldsResult = { fields };
      respond(result);
      return;
    }

    if (action === 'FILL_FORM') {
      const { fileBuffer, fileName, values, flatten } = payload as FillFormPayload;
      emitProgress(20, 'Loading document...');
      const pdfDoc = await PDFDocument.load(fileBuffer);
      const form = pdfDoc.getForm();

      emitProgress(50, 'Filling fields...');
      for (const field of form.getFields()) {
        const name = field.getName();
        if (!(name in values)) continue;
        const value = values[name];
        if (field instanceof PDFTextField && typeof value === 'string') {
          field.setText(value);
        } else if (field instanceof PDFCheckBox && typeof value === 'boolean') {
          if (value) field.check();
          else field.uncheck();
        } else if (field instanceof PDFRadioGroup && typeof value === 'string') {
          field.select(value);
        } else if ((field instanceof PDFDropdown || field instanceof PDFOptionList) && typeof value === 'string') {
          field.select(value);
        }
      }

      if (flatten) {
        emitProgress(75, 'Flattening form...');
        form.flatten();
      }

      emitProgress(90, 'Saving PDF...');
      const bytes = await pdfDoc.save();
      const resultBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const cleanBaseName = fileName.replace(/\.[^/.]+$/, '');
      const result: ProcessedPdfResult = {
        fileName: `${cleanBaseName}_filled.pdf`,
        buffer: resultBuffer,
        size: resultBuffer.byteLength,
        pageCount: pdfDoc.getPageCount(),
      };
      emitProgress(100, 'Done.');
      const responseMsg: WorkerIncomingMessage<ProcessedPdfResult> = {
        type: 'RESPONSE',
        payload: { id, success: true, data: result },
      };
      (self as any).postMessage(responseMsg, [resultBuffer]);
      return;
    }
  } catch (err) {
    respondFail(err);
  }
});
