import React from 'react';
import { OfficeToPdfView } from '../../components/convert/OfficeToPdfView';
import { nativeFirst } from '../../services/nativeWorker';
import { excelToPdfNative } from './excelToPdf.native';

export const ExcelToPdfView: React.FC<{ onBack: () => void }> = ({ onBack }) => (
  <OfficeToPdfView
    toolId="excelToPdf"
    accept=".xlsx,.xls,.xlsm,.ods,.csv"
    action="XLSX_TO_PDF"
    workerFactory={nativeFirst(() => new Worker(new URL('./xlsxToPdf.worker.ts', import.meta.url), { type: 'module' }), { XLSX_TO_PDF: excelToPdfNative })}
    title="Choose a spreadsheet"
    subtitle=".xlsx, .xls, .ods or .csv"
    notes={
      <>
        <p>Every sheet becomes a table with values formatted the way Excel shows them. Wide sheets are scaled down, and split across pages when they still don’t fit.</p>
        <p>Charts, images and cell colors aren’t carried over.</p>
      </>
    }
    onBack={onBack}
  />
);
