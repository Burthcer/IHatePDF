import React from 'react';
import { Moon, Sun } from 'lucide-react';
import { IconButton } from '../ui';
import { useTheme } from '../../hooks/useTheme';
import { SiteLinks } from './SiteLinks';

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
          <SiteLinks />
        </div>
      </div>
    </header>
  );
};
