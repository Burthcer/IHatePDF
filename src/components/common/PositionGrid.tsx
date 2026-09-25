import React from 'react';
import type { WatermarkPosition } from '../../types/worker';
import { cn } from '../ui';

interface PositionGridProps {
  value: WatermarkPosition;
  onChange: (position: WatermarkPosition) => void;
  /** Positions to offer (default: all nine). */
  allowed?: WatermarkPosition[];
  accentColor?: string;
}

const GRID: WatermarkPosition[] = ['top-left', 'top-center', 'top-right', 'center-left', 'center', 'center-right', 'bottom-left', 'bottom-center', 'bottom-right'];

/** 3×3 picker drawn as a tiny page. */
export const PositionGrid: React.FC<PositionGridProps> = ({ value, onChange, allowed }) => (
  <div className="grid grid-cols-3 gap-1 w-[84px] h-[108px] p-1.5 bg-white border border-line-strong rounded-sm">
    {GRID.map((pos) => {
      const enabled = !allowed || allowed.includes(pos);
      return (
        <button
          key={pos}
          type="button"
          disabled={!enabled}
          aria-label={pos.replace('-', ' ')}
          aria-pressed={pos === value}
          title={pos.replace('-', ' ')}
          onClick={() => onChange(pos)}
          className={cn(
            'rounded-[2px] transition-colors',
            pos === value ? 'bg-accent' : enabled ? 'bg-[#e9e6de] hover:bg-[#d8d4c9]' : 'bg-transparent'
          )}
        />
      );
    })}
  </div>
);
