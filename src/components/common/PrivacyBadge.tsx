import React, { useState } from 'react';
import { ShieldCheck, Info, Cpu, WifiOff, HardDrive } from 'lucide-react';

interface PrivacyBadgeProps {
  className?: string;
  variant?: 'compact' | 'detailed';
}

export const PrivacyBadge: React.FC<PrivacyBadgeProps> = ({
  className = '',
  variant = 'compact',
}) => {
  const [showTooltip, setShowTooltip] = useState(false);

  if (variant === 'detailed') {
    return (
      <div
        className={`bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/60 rounded-xl p-4 text-emerald-900 dark:text-emerald-100 ${className}`}
      >
        <div className="flex items-start gap-3">
          <div className="p-2 bg-emerald-100 dark:bg-emerald-900/60 rounded-lg text-emerald-600 dark:text-emerald-400 shrink-0">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h4 className="font-semibold text-sm">100% Client-Side Architecture</h4>
              <span className="text-xs bg-emerald-200 dark:bg-emerald-800 text-emerald-800 dark:text-emerald-200 px-2 py-0.5 rounded-full font-medium">
                Zero Cloud Storage
              </span>
            </div>
            <p className="text-xs text-emerald-700 dark:text-emerald-300 leading-relaxed">
              Your files never leave your device. All rendering, compression, encryption, and manipulation execute strictly in local browser memory using WebAssembly & Web Workers.
            </p>
            <div className="flex flex-wrap items-center gap-4 pt-2 text-[11px] text-emerald-800 dark:text-emerald-300">
              <span className="flex items-center gap-1">
                <WifiOff className="w-3.5 h-3.5" /> No Network Payload Transfer
              </span>
              <span className="flex items-center gap-1">
                <Cpu className="w-3.5 h-3.5" /> WebAssembly & Worker Isolation
              </span>
              <span className="flex items-center gap-1">
                <HardDrive className="w-3.5 h-3.5" /> RAM-Only Buffers
              </span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`relative inline-block ${className}`}>
      <button
        type="button"
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
        onClick={() => setShowTooltip((prev) => !prev)}
        aria-label="Zero server privacy guarantee"
        className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-100 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-700/60 hover:bg-emerald-200 transition-colors shadow-sm"
      >
        <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
        <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
        <span>100% Client-Side / Zero Server</span>
        <Info className="w-3 h-3 text-emerald-600/70" />
      </button>

      {showTooltip && (
        <div className="absolute left-1/2 -translate-x-1/2 top-full mt-2 w-72 p-3 bg-slate-900 text-white rounded-lg shadow-xl text-xs z-50 border border-slate-700 pointer-events-none">
          <p className="font-semibold text-emerald-400 mb-1">True Privacy Guaranteed</p>
          <p className="text-slate-300 leading-snug">
            All PDF operations run entirely inside your browser using Web Workers and WebAssembly. No files or byte streams are uploaded to any server.
          </p>
          <div className="absolute -top-1.5 left-1/2 -translate-x-1/2 w-3 h-3 bg-slate-900 rotate-45 border-t border-l border-slate-700" />
        </div>
      )}
    </div>
  );
};
