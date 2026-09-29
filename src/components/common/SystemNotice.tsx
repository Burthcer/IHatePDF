/**
 * App-wide notices from the desktop shell: the window was reloaded after its
 * page crashed or was ended by the memory fail-safe, and "Low on memory:
 * taking longer" while a job works in smaller pieces or pauses to stay within
 * the RAM budget. (Jobs the fail-safe stops show their own message in the tool.)
 */

import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { Notice } from '../ui';
import { jobsRunning, memoryState, subscribeMemory, type MemoryState } from '../../services/memoryGuard';

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
  const [busy, setBusy] = useState(jobsRunning);
  useEffect(
    () =>
      subscribeMemory((s) => {
        setMem(s);
        setBusy(jobsRunning());
      }),
    []
  );
  useEffect(() => {
    // Don't show the recovery note again on a later reload.
    if (recovered) window.history.replaceState(null, '', window.location.pathname + window.location.hash);
  }, [recovered]);

  const slowed = busy && (mem.level === 'high' || mem.level === 'over');
  if (!recovered && !slowed) return null;
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
        <Notice tone="info" title="Low on memory: taking longer">
          {mem.level === 'over' ? 'Paused for a moment while memory frees up. ' : ''}
          IHatePDF is working in smaller pieces to stay within the {gb(mem.budgetMB)} it may use on this PC. The job will finish; it just takes longer.
        </Notice>
      )}
    </div>
  );
};
