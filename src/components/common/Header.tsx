import React from 'react';
import { Moon, Sun } from 'lucide-react';
import { IconButton } from '../ui';
import { useTheme } from '../../hooks/useTheme';

export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`font-mono font-medium tracking-tight ${className}`}>
      ihate<span className="line-through decoration-accent decoration-2">pdf</span>
    </span>
  );
}

interface HeaderProps {
  onHome: () => void;
}

export const Header: React.FC<HeaderProps> = ({ onHome }) => {
  const { theme, toggleTheme } = useTheme();
  return (
    <header className="sticky top-0 z-40 h-12 border-b border-line bg-panel/95 backdrop-blur supports-[backdrop-filter]:bg-panel/80">
      <div className="h-full max-w-[1400px] mx-auto px-4 sm:px-6 flex items-center justify-between gap-4">
        <button type="button" onClick={onHome} className="text-[15px] rounded focus-visible:outline-offset-4" aria-label="All tools">
          <Wordmark />
        </button>
        <div className="flex items-center gap-3">
          <span className="hidden sm:inline font-mono text-2xs text-muted">runs offline · nothing is uploaded</span>
          <IconButton label={theme === 'dark' ? 'Light mode' : 'Dark mode'} onClick={toggleTheme}>
            {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </IconButton>
          <a
            href="https://github.com/burthcer/IHatePDF"
            target="_blank"
            rel="noreferrer"
            aria-label="Source code on GitHub"
            title="Source code"
            className="inline-flex items-center justify-center w-8 h-8 rounded hover:bg-hover"
          >
            <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 2C6.48 2 2 6.48 2 12.02c0 4.42 2.87 8.17 6.84 9.5.5.09.68-.22.68-.48l-.01-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.89 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.64-1.34-2.22-.25-4.56-1.11-4.56-4.95 0-1.09.39-1.99 1.03-2.69-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.03A9.56 9.56 0 0 1 12 6.84c.85 0 1.71.11 2.5.34 1.91-1.3 2.75-1.03 2.75-1.03.55 1.38.2 2.4.1 2.65.64.7 1.03 1.6 1.03 2.69 0 3.85-2.34 4.7-4.57 4.94.36.31.68.92.68 1.86l-.01 2.75c0 .27.18.58.69.48A10.02 10.02 0 0 0 22 12.02C22 6.48 17.52 2 12 2z" />
            </svg>
          </a>
        </div>
      </div>
    </header>
  );
};
