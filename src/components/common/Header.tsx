import React from 'react';
import { FileText, Home, Moon, Sun } from 'lucide-react';
import { PrivacyBadge } from './PrivacyBadge';
import { useTheme } from '../../hooks/useTheme';
import type { ToolType, ToolCategory } from '../../types/pdf';

interface HeaderProps {
  activeTool: ToolType | null;
  onSelectTool: (tool: ToolType | null) => void;
  category: ToolCategory | 'all';
  onSelectCategory: (category: ToolCategory | 'all') => void;
  categories: Array<{ id: ToolCategory | 'all'; label: string }>;
}

export const Header: React.FC<HeaderProps> = ({
  activeTool,
  onSelectTool,
  category,
  onSelectCategory,
  categories,
}) => {
  const { theme, toggleTheme } = useTheme();

  return (
    <header className="sticky top-0 z-40 w-full border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-14 flex items-center justify-between gap-4">
        {/* Brand */}
        <div className="flex items-center gap-4 min-w-0">
          <button
            type="button"
            onClick={() => onSelectTool(null)}
            className="flex items-center gap-2 text-left focus:outline-none focus:ring-2 focus:ring-slate-400 rounded-lg p-1 shrink-0 active:scale-95 transition-transform"
          >
            <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 flex items-center justify-center text-white shadow-md shadow-brand-600/30">
              <FileText className="w-4 h-4" />
            </div>
            <span className="font-bold text-base text-slate-900 dark:text-white">
              IHate<span className="text-brand-600">PDF</span>
            </span>
          </button>

          {activeTool ? (
            <div className="hidden md:flex items-center gap-1.5 text-sm text-slate-500 dark:text-slate-400 truncate">
              <span>/</span>
              <button
                onClick={() => onSelectTool(null)}
                className="hover:text-slate-900 dark:hover:text-white flex items-center gap-1 transition-colors"
              >
                <Home className="w-3.5 h-3.5" />
                <span>Tools</span>
              </button>
            </div>
          ) : (
            <nav className="hidden md:flex items-center gap-1">
              {categories.map((c) => (
                <button
                  key={c.id}
                  onClick={() => onSelectCategory(c.id)}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-full active:scale-95 transition-all duration-150 ${
                    category === c.id
                      ? 'bg-brand-600 text-white shadow-sm shadow-brand-600/40'
                      : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </nav>
          )}
        </div>

        {/* Right Action Items */}
        <div className="flex items-center gap-2 shrink-0">
          <PrivacyBadge />

          <button
            type="button"
            onClick={toggleTheme}
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            className="p-2 text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 rounded-full active:scale-90 transition-all duration-150"
          >
            {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>

          <a
            href="https://github.com"
            target="_blank"
            rel="noreferrer"
            aria-label="GitHub Repository"
            className="p-2 text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 rounded-full active:scale-90 transition-all duration-150"
          >
            <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24">
              <path
                fillRule="evenodd"
                clipRule="evenodd"
                d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
              />
            </svg>
          </a>

          {activeTool && (
            <button
              onClick={() => onSelectTool(null)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-full active:scale-95 transition-all duration-150"
            >
              <span>All Tools</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
};
