/**
 * Saves a finished result on its own: a short countdown, then the file is
 * written under its suggested name. During the countdown the name can be
 * changed (or the save cancelled). In the desktop app files go straight to
 * Downloads\IHatePDF without a dialog, and the saved location is shown.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Check, Download, FolderOpen, Pencil } from 'lucide-react';
import { Button, cn } from '../ui';
import { AUTOSAVE_SECONDS, cleanFileName, splitFileName } from '../../services/fileNames';

type Phase = 'counting' | 'renaming' | 'paused' | 'saved';

interface AutoSaveProps {
  /** Suggested name, with extension. */
  fileName: string;
  /** Writes the file under the given name (extension included). */
  onSave: (fileName: string) => void;
  /** Start in the countdown (default) or wait for the user. */
  autoStart?: boolean;
  className?: string;
}

/** Key this component to the result (see resultKey) so a new result restarts the countdown. */
export const AutoSave: React.FC<AutoSaveProps> = ({ fileName, onSave, autoStart = true, className }) => {
  const { base, ext } = splitFileName(fileName);
  const [phase, setPhase] = useState<Phase>(autoStart ? 'counting' : 'paused');
  const [left, setLeft] = useState(AUTOSAVE_SECONDS);
  const [name, setName] = useState(base);
  const [savedAs, setSavedAs] = useState<string | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const saveRef = useRef<(n?: string) => void>(() => {});

  const save = (n: string = name) => {
    const final = (cleanFileName(n) || base) + ext;
    setSavedPath(null);
    onSave(final);
    setSavedAs(final);
    setName(splitFileName(final).base);
    setPhase('saved');
  };
  useEffect(() => {
    saveRef.current = save;
  });

  // Countdown.
  useEffect(() => {
    if (phase !== 'counting') return;
    if (left <= 0) {
      saveRef.current();
      return;
    }
    const t = window.setTimeout(() => setLeft((l) => l - 1), 1000);
    return () => window.clearTimeout(t);
  }, [phase, left]);

  // Desktop app: learn where the file actually landed.
  useEffect(() => {
    if (phase !== 'saved' || !window.ihpDesktop) return;
    return window.ihpDesktop.onSaved((info) => setSavedPath(info.path));
  }, [phase, savedAs]);

  useEffect(() => {
    if (phase === 'renaming') inputRef.current?.select();
  }, [phase]);

  if (phase === 'renaming') {
    return (
      <form
        className={cn('space-y-2', className)}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <label className="block text-xs text-muted" htmlFor="autosave-name">
          Save as
        </label>
        <div className="flex items-center gap-1.5">
          <input
            id="autosave-name"
            ref={inputRef}
            className="input font-mono text-xs"
            value={name}
            autoFocus
            spellCheck={false}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setPhase(savedAs ? 'saved' : 'paused');
              }
            }}
            aria-label="File name"
          />
          {ext && <span className="text-xs text-muted font-mono shrink-0">{ext}</span>}
        </div>
        <div className="flex gap-2">
          <Button type="submit" variant="primary" size="lg" className="flex-1" icon={<Download className="w-4 h-4" />}>
            Save
          </Button>
          <Button size="lg" variant="ghost" onClick={() => setPhase(savedAs ? 'saved' : 'paused')}>
            Cancel
          </Button>
        </div>
      </form>
    );
  }

  if (phase === 'counting') {
    return (
      <div className={cn('space-y-2', className)} role="status">
        <p className="text-xs text-muted">
          Saving as <span className="font-mono text-ink break-all">{(cleanFileName(name) || base) + ext}</span> in {left}s
        </p>
        <div className="h-0.5 bg-sunken rounded overflow-hidden">
          <div className="h-full bg-accent autosave-bar" style={{ animationDuration: `${AUTOSAVE_SECONDS}s` }} />
        </div>
        <div className="flex gap-2">
          <Button variant="primary" size="lg" className="flex-1" icon={<Download className="w-4 h-4" />} onClick={() => save()}>
            Save now
          </Button>
          <Button size="lg" icon={<Pencil className="w-3.5 h-3.5" />} onClick={() => setPhase('renaming')}>
            Rename
          </Button>
        </div>
        <button type="button" className="text-2xs text-muted hover:text-ink underline-offset-2 hover:underline" onClick={() => setPhase('paused')}>
          Don’t save automatically
        </button>
      </div>
    );
  }

  if (phase === 'saved') {
    return (
      <div className={cn('space-y-2', className)} role="status">
        <p className="text-xs flex items-start gap-1.5">
          <Check className="w-3.5 h-3.5 text-ok shrink-0 mt-px" />
          <span>
            Saved as <span className="font-mono break-all">{savedAs}</span>
            {savedPath && <span className="block text-muted break-all mt-0.5">{savedPath}</span>}
          </span>
        </p>
        {savedPath && window.ihpDesktop ? (
          <Button size="lg" block icon={<FolderOpen className="w-4 h-4" />} onClick={() => window.ihpDesktop!.showInFolder(savedPath)}>
            Show in folder
          </Button>
        ) : (
          <Button size="lg" block icon={<Download className="w-4 h-4" />} onClick={() => save(savedAs ? splitFileName(savedAs).base : name)}>
            Download again
          </Button>
        )}
        <button type="button" className="text-2xs text-muted hover:text-ink underline-offset-2 hover:underline inline-flex items-center gap-1" onClick={() => setPhase('renaming')}>
          <Pencil className="w-3 h-3" /> Save a copy under another name
        </button>
      </div>
    );
  }

  // paused
  return (
    <div className={cn('flex gap-2', className)}>
      <Button variant="primary" size="lg" className="flex-1" icon={<Download className="w-4 h-4" />} onClick={() => save()}>
        Download
      </Button>
      <Button size="lg" icon={<Pencil className="w-3.5 h-3.5" />} onClick={() => setPhase('renaming')}>
        Rename
      </Button>
    </div>
  );
};
