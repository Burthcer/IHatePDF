import React from 'react';
import { OfficeToPdfView } from '../../components/convert/OfficeToPdfView';

export const PptToPdfView: React.FC<{ onBack: () => void }> = ({ onBack }) => (
  <OfficeToPdfView
    toolId="pptToPdf"
    accept=".pptx"
    action="PPT_TO_PDF"
    workerFactory={() => new Worker(new URL('./pptToPdf.worker.ts', import.meta.url), { type: 'module' })}
    title="Choose a PowerPoint file"
    subtitle=".pptx — or drag it here"
    notes={
      <>
        <p>One slide per page at the deck’s own size, with backgrounds, shapes, images and text boxes.</p>
        <p>Animations, charts and SmartArt aren’t rendered. Old .ppt files need to be saved as .pptx first.</p>
      </>
    }
    onBack={onBack}
  />
);
