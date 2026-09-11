import React from 'react';
import { Loader2 } from 'lucide-react';

interface ProgressBarProps {
  progress: number;
  stage?: string;
  className?: string;
  isIndeterminate?: boolean;
  accentColor?: string;
}

export const ProgressBar: React.FC<ProgressBarProps> = ({
  progress,
  stage = 'Processing document...',
  className = '',
  isIndeterminate = false,
  accentColor = '#E53E3E',
}) => {
  const clampedProgress = Math.min(100, Math.max(0, Math.round(progress)));

  return (
    <div className={`w-full space-y-2 ${className}`}>
      <div className="flex items-center justify-between text-xs font-medium text-slate-700 dark:text-slate-300">
        <span className="flex items-center gap-1.5 truncate">
          <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: accentColor }} />
          <span className="truncate">{stage}</span>
        </span>
        <span className="tabular-nums font-semibold" style={{ color: accentColor }}>
          {isIndeterminate ? 'Working...' : `${clampedProgress}%`}
        </span>
      </div>

      <div className="w-full h-2.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
        {isIndeterminate ? (
          <div
            className="h-full rounded-full w-1/3 animate-[indeterminate_1.5s_infinite_linear]"
            style={{ backgroundColor: accentColor, boxShadow: `0 0 10px ${accentColor}99` }}
          />
        ) : (
          <div
            className="h-full rounded-full transition-all duration-500 ease-out-expo"
            style={{ width: `${clampedProgress}%`, backgroundColor: accentColor, boxShadow: `0 0 10px ${accentColor}99` }}
          />
        )}
      </div>
    </div>
  );
};
