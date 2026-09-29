/**
 * App-wide notices from the desktop shell: the window was reloaded after its
 * page crashed or was ended by the memory fail-safe, and "memory is tight".
 * (Jobs the fail-safe stops also show their own message in the tool.)
 */

import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { Notice } from '../ui';
import { memoryState, subscribeMemory, type MemoryState } from '../../services/memoryGuard';

function recoveredReason(): 'memory' | 'crash' | null {
  try {
    const r = new URLSearchParams(window.location.search).get('recovered');
    return r === 'memory' || r === 'crash' ? r : null;
  } catch {
    return null;
  }
}

const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;

export const SystemNotice: React.FC = () => {
  const [recovered, setRecovered] = useState(recoveredReason);
  const [mem, setMem] = useState<MemoryState>(memoryState);
  useEffect(() => subscribeMemory(setMem), []);
  useEffect(() => {
    // Don't show the recovery note again on a later reload.
    if (recovered) window.history.replaceState(null, '', window.location.pathname + window.location.hash);
  }, [recovered]);

  if (!recovered && mem.level !== 'high') return null;
  return (
    <div className="max-w-[1400px] mx-auto px-4 sm:px-6 pt-4">
      {recovered ? (
        <div className="relative">
          <Notice tone="warn" title={recovered === 'memory' ? 'IHatePDF restarted to protect this PC' : 'IHatePDF recovered from a problem'}>
            {recovered === 'memory'
              ? `The last job needed more memory than IHatePDF may use on this PC (${gb(mem.budgetMB)} of ${gb(mem.totalMB)}), so it was stopped. Nothing was saved from it. Try again with other programs closed, or split the file into smaller parts first.`
              : 'The window stopped working and was reloaded. The last job didn’t finish — please run it again.'}
          </Notice>
          <button aria-label="Dismiss" className="absolute top-2 right-2 text-muted hover:text-ink" onClick={() => setRecovered(null)}>
            <X className="w-4 h-4" />
          </button>
        </div>
      ) : (
        <Notice tone="info" title="Memory is getting tight">
          IHatePDF is using {gb(mem.usedMB)} of the {gb(mem.budgetMB)} it’s allowed on this PC, so it’s working more slowly to stay within that.
        </Notice>
      )}
    </div>
  );
};
