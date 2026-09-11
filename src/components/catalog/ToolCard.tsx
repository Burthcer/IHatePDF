import React from 'react';
import {
  Combine,
  Scissors,
  RotateCw,
  LayoutGrid,
  Minimize2,
  Lock,
  Unlock,
  Crop,
  Stamp,
  Hash,
  FileText,
  FileType,
  Presentation,
  MonitorPlay,
  Image,
  ImagePlus,
  FileCode,
  Wrench,
  Table,
  FileSpreadsheet,
  Archive,
  ListChecks,
  PenLine,
  Code2,
  EyeOff,
  GitCompare,
  Camera,
  PenSquare,
  ArrowRight,
} from 'lucide-react';
import type { ToolMetadata, ToolType } from '../../types/pdf';

interface ToolCardProps {
  tool: ToolMetadata;
  onSelect: (id: ToolType) => void;
}

const ICON_MAP: Record<string, React.ElementType> = {
  Combine,
  Scissors,
  RotateCw,
  LayoutGrid,
  Minimize2,
  Lock,
  Unlock,
  Crop,
  Stamp,
  Hash,
  FileText,
  FileType,
  Presentation,
  MonitorPlay,
  ImageIcon: Image,
  ImagePlus,
  FileCode,
  Wrench,
  Table,
  FileSpreadsheet,
  Archive,
  ListChecks,
  PenLine,
  Code2,
  EyeOff,
  GitCompare,
  Camera,
  PenSquare,
};

/** Darkens a hex color by `amount` (0-1) for gradient end-stops. */
function shade(hex: string, amount: number): string {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = Math.max(0, Math.round(((n >> 16) & 255) * (1 - amount)));
  const g = Math.max(0, Math.round(((n >> 8) & 255) * (1 - amount)));
  const b = Math.max(0, Math.round((n & 255) * (1 - amount)));
  return `rgb(${r}, ${g}, ${b})`;
}

function hexToRgba(hex: string, alpha: number): string {
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export const ToolCard: React.FC<ToolCardProps> = ({ tool, onSelect }) => {
  const IconComponent = ICON_MAP[tool.icon] || Combine;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(tool.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          onSelect(tool.id);
        }
      }}
      className="group relative flex flex-col justify-between p-5 bg-white dark:bg-slate-900 rounded-3xl shadow-soft dark:shadow-soft-dark hover:shadow-soft-lg dark:hover:shadow-soft-dark-lg hover:-translate-y-1 active:scale-[0.98] active:translate-y-0 transition-all duration-300 ease-out-expo cursor-pointer text-left overflow-hidden focus:outline-none focus:ring-2 focus:ring-offset-2"
      style={{ '--tw-ring-color': tool.color, '--tool-color': tool.color } as React.CSSProperties}
    >
      {/* Soft color wash that blooms in on hover — the "purposeful, not gray" cue */}
      <div
        className="pointer-events-none absolute -top-10 -right-10 w-32 h-32 rounded-full blur-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-500"
        style={{ backgroundColor: hexToRgba(tool.color, 0.16) }}
      />

      <div className="relative space-y-3.5">
        <div className="flex items-start justify-between">
          <div
            className="w-11 h-11 rounded-2xl flex items-center justify-center text-white shrink-0 transition-transform duration-300 ease-spring group-hover:scale-105 group-hover:-rotate-3"
            style={{
              backgroundImage: `linear-gradient(135deg, ${tool.color}, ${shade(tool.color, 0.28)})`,
              boxShadow: `0 6px 16px -4px ${hexToRgba(tool.color, 0.5)}`,
            }}
          >
            <IconComponent className="w-5 h-5" />
          </div>

          {tool.badge && (
            <span
              className="text-[10px] font-bold px-2 py-0.5 rounded-full"
              style={{ backgroundColor: hexToRgba(tool.color, 0.12), color: tool.color }}
            >
              {tool.badge}
            </span>
          )}
        </div>

        <div>
          <h3 className="text-base font-bold text-slate-900 dark:text-white">{tool.title}</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1.5 line-clamp-2 leading-relaxed">
            {tool.description}
          </p>
        </div>
      </div>

      <div className="relative pt-3.5 mt-3.5 border-t border-slate-100 dark:border-slate-800/80 flex items-center justify-between text-xs font-semibold text-slate-400 dark:text-slate-500 group-hover:text-[color:var(--tool-color)] transition-colors duration-300">
        <span>Open Tool</span>
        <ArrowRight className="w-3.5 h-3.5 transition-transform duration-300 ease-spring group-hover:translate-x-1" />
      </div>
    </div>
  );
};
