import React from 'react';
import { OfficeToPdfView } from '../../components/convert/OfficeToPdfView';

export const WordToPdfView: React.FC<{ onBack: () => void }> = ({ onBack }) => (
  <OfficeToPdfView
    toolId="wordToPdf"
    accept=".docx"
    action="WORD_TO_PDF"
    workerFactory={() => new Worker(new URL('./wordToPdf.worker.ts', import.meta.url), { type: 'module' })}
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
