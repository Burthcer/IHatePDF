import React from 'react';
import { Wordmark } from './Header';

export const Footer: React.FC = () => (
  <footer className="border-t border-line mt-auto">
    <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-6 flex flex-col sm:flex-row gap-2 sm:items-center justify-between text-xs text-muted">
      <p>
        <Wordmark className="text-ink" /> — every tool runs in this browser tab. No uploads, no accounts, no page limits.
      </p>
      <p className="font-mono text-2xs">pdf-lib · pdf.js · MIT licensed</p>
    </div>
  </footer>
);
