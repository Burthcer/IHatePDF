import React from 'react';
import { OfficeToPdfView } from '../../components/convert/OfficeToPdfView';
import { nativeFirst } from '../../services/nativeWorker';
import { wordToPdfNative } from './wordToPdf.native';

export const WordToPdfView: React.FC<{ onBack: () => void }> = ({ onBack }) => (
  <OfficeToPdfView
    toolId="wordToPdf"
    accept=".docx"
    action="WORD_TO_PDF"
    workerFactory={nativeFirst(() => new Worker(new URL('./wordToPdf.worker.ts', import.meta.url), { type: 'module' }), { WORD_TO_PDF: wordToPdfNative })}
    title="Choose a Word document"
    subtitle=".docx — or drag it here"
    notes={
      <>
        <p>Keeps text formatting, headings, colors, tables with shading and borders, and page breaks.</p>
        <p>Old .doc files aren’t supported — open them in Word and save as .docx first. Fonts are mapped to Helvetica / Liberation Sans.</p>
      </>
    }
    onBack={onBack}
  />
);
