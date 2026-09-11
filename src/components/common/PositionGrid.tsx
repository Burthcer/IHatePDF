import React from 'react';
import type { WatermarkPosition } from '../../types/worker';

interface PositionGridProps {
  value: WatermarkPosition;
  onChange: (position: WatermarkPosition) => void;
  accentColor?: string;
}

const GRID: WatermarkPosition[] = [
  'top-left', 'top-center', 'top-right',
  'center-left', 'center', 'center-right',
  'bottom-left', 'bottom-center', 'bottom-right',
];

export const PositionGrid: React.FC<PositionGridProps> = ({ value, onChange, accentColor = '#475569' }) => {
  return (
    <div className="grid grid-cols-3 gap-1.5 w-full max-w-[160px] aspect-square p-2 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg">
      {GRID.map((pos) => {
        const active = pos === value;
        return (
          <button
            key={pos}
            type="button"
            aria-label={pos.replace('-', ' ')}
            onClick={() => onChange(pos)}
            className="rounded-md border transition-colors"
            style={
              active
                ? { backgroundColor: accentColor, borderColor: accentColor }
                : { borderColor: 'transparent' }
            }
          >
            <span
              className={`block w-full h-full rounded-md ${
                active ? '' : 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-300'
              }`}
            />
          </button>
        );
      })}
    </div>
  );
};
