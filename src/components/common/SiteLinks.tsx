import React from 'react';
import { cn } from '../ui';

const SITE = 'https://devbhamaria.com';
const REPO = 'https://github.com/Burthcer/IHatePDF';

/** devbhamaria.com's own favicon (the "D." mark), inline so it works offline. */
function SiteMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="14" fill="#285296" />
      <path fill="#f3f0e8" fillRule="evenodd" d="M14 16h12a16 16 0 0 1 0 32H14zM22 23h4a9 9 0 0 1 0 18h-4z" />
      <circle cx="46.5" cy="44.5" r="3.5" fill="#ddeb79" />
    </svg>
  );
}

/**
 * The maker's website and the source code, as header buttons. Plain links: in the desktop and phone apps the
 * bridges (desktopBridge.ts, mobile/web/bridge.ts) send any http(s) link to the system browser.
 */
export function SiteLinks({ size = 'md' }: { size?: 'md' | 'lg' }) {
  const box = size === 'lg' ? 'w-10 h-10' : 'w-8 h-8';
  const icon = size === 'lg' ? 'w-5 h-5' : 'w-4 h-4';
  return (
    <>
      <a href={SITE} target="_blank" rel="noreferrer" aria-label="Made by Dev Bhamaria: devbhamaria.com" title="devbhamaria.com" className={cn('inline-flex items-center justify-center rounded hover:bg-hover', box)}>
        <SiteMark className={icon} />
      </a>
      <a href={REPO} target="_blank" rel="noreferrer" aria-label="Source code on GitHub" title="Source code on GitHub" className={cn('inline-flex items-center justify-center rounded hover:bg-hover', box)}>
        <svg className={cn(icon, 'fill-current')} viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 2C6.48 2 2 6.48 2 12.02c0 4.42 2.87 8.17 6.84 9.5.5.09.68-.22.68-.48l-.01-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.89 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.64-1.34-2.22-.25-4.56-1.11-4.56-4.95 0-1.09.39-1.99 1.03-2.69-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.03A9.56 9.56 0 0 1 12 6.84c.85 0 1.71.11 2.5.34 1.91-1.3 2.75-1.03 2.75-1.03.55 1.38.2 2.4.1 2.65.64.7 1.03 1.6 1.03 2.69 0 3.85-2.34 4.7-4.57 4.94.36.31.68.92.68 1.86l-.01 2.75c0 .27.18.58.69.48A10.02 10.02 0 0 0 22 12.02C22 6.48 17.52 2 12 2z" />
        </svg>
      </a>
    </>
  );
}
