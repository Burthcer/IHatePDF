import React from 'react';
import { ShieldCheck, Heart, Cpu, FileCheck } from 'lucide-react';

export const Footer: React.FC = () => {
  return (
    <footer className="w-full border-t border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-950 py-10 px-4 sm:px-6 lg:px-8 mt-auto">
      <div className="max-w-7xl mx-auto space-y-8">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 text-sm">
          <div className="space-y-2">
            <div className="flex items-center gap-2 font-bold text-slate-900 dark:text-white">
              <ShieldCheck className="w-4 h-4 text-emerald-500" />
              <span>Zero-Server Privacy Promise</span>
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              Every document manipulation happens exclusively in your browser’s memory using WebAssembly & Web Workers. We have no servers to store, view, or leak your data.
            </p>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2 font-bold text-slate-900 dark:text-white">
              <Cpu className="w-4 h-4 text-rose-500" />
              <span>No Limits, No Paywalls</span>
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              Unlike commercial alternatives that limit pages or throttle file sizes, IHatePDF gives you unrestricted local document tooling at native hardware speeds.
            </p>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2 font-bold text-slate-900 dark:text-white">
              <FileCheck className="w-4 h-4 text-blue-500" />
              <span>Open Source & Verifiable</span>
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              Inspect our network tab anytime: document payloads generate zero HTTP requests. Open source and built for security-conscious professionals.
            </p>
          </div>
        </div>

        <div className="pt-6 border-t border-slate-200 dark:border-slate-800/80 flex flex-col sm:flex-row items-center justify-between text-xs text-slate-500 gap-4">
          <p>© {new Date().getFullYear()} IHatePDF. Built for the privacy-first web.</p>
          <div className="flex items-center gap-1">
            <span>Engineered with</span>
            <Heart className="w-3.5 h-3.5 text-rose-500 fill-rose-500 inline" />
            <span>using WebAssembly, pdf-lib, and pdfjs-dist.</span>
          </div>
        </div>
      </div>
    </footer>
  );
};
