import React, { useEffect, useState } from 'react';
import { Wordmark } from './Header';

/** Desktop app only: says the local usage log exists, what it holds, and lets the user switch it off. */
const UsageLogNotice: React.FC = () => {
  const log = window.ihpDesktop?.log;
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    void log?.info().then((i) => setOn(i.enabled));
  }, [log]);
  if (!log || on === null) return null;
  return (
    <p>
      {on ? 'A usage log stays on this PC: tools used, sizes, times, errors. Never file names or content, never uploaded. ' : 'The usage log is off. '}
      <button type="button" className="underline hover:text-ink" onClick={() => void log.setEnabled(!on).then(setOn)}>
        {on ? 'Turn off' : 'Turn on'}
      </button>
    </p>
  );
};

export const Footer: React.FC = () => (
  <footer className="border-t border-line mt-auto">
    <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-6 flex flex-col sm:flex-row gap-2 sm:items-center justify-between text-xs text-muted">
      <div className="flex flex-col gap-1">
        <p>
          <Wordmark className="text-ink" /> — every tool runs in this browser tab. No uploads, no accounts, no page limits.
        </p>
        <UsageLogNotice />
      </div>
      <p className="font-mono text-2xs">pdf-lib · pdf.js · MIT licensed</p>
    </div>
  </footer>
);
