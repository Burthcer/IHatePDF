/**
 * Small set of UI primitives every screen is built from. Deliberately
 * plain: hairline borders, no gradients or glows, one accent color used
 * only for the primary action and selection.
 */

import React, { useEffect, useId, useRef } from 'react';
import { AlertTriangle, CheckCircle2, Info, Loader2, X, XCircle } from 'lucide-react';
import { cn } from './cn';

export { cn };

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: React.ReactNode;
  loading?: boolean;
  block?: boolean;
}

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-ink border-accent hover:brightness-95 active:brightness-90',
  secondary: 'bg-panel text-ink border-line-strong hover:border-muted hover:bg-hover',
  ghost: 'bg-transparent text-ink border-transparent hover:bg-hover',
  danger: 'bg-panel text-danger border-line-strong hover:border-danger',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-xs gap-1.5',
  md: 'h-8 px-3 text-sm gap-2',
  lg: 'h-10 px-4 text-sm gap-2 font-medium',
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, loading, block, className, children, disabled, type = 'button', ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center rounded border font-medium whitespace-nowrap transition-colors select-none',
        'disabled:opacity-45 disabled:pointer-events-none',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        block && 'w-full',
        className
      )}
      {...rest}
    >
      {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : icon}
      {children}
    </button>
  );
});

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
  size?: 'sm' | 'md';
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, active, size = 'md', className, children, type = 'button', ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={cn(
        'inline-flex items-center justify-center rounded border transition-colors shrink-0',
        'disabled:opacity-40 disabled:pointer-events-none',
        size === 'sm' ? 'w-7 h-7' : 'w-8 h-8',
        active ? 'bg-ink text-paper border-ink' : 'border-transparent text-ink hover:bg-hover',
        className
      )}
      {...rest}
    >
      {children}
    </button>
  );
});

export function Field({
  label,
  hint,
  children,
  htmlFor,
  aside,
  className,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactNode;
  htmlFor?: string;
  aside?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={htmlFor} className="text-xs font-medium text-ink">
          {label}
        </label>
        {aside && <span className="font-mono text-2xs text-muted">{aside}</span>}
      </div>
      {children}
      {hint && <p className="text-2xs text-muted leading-snug">{hint}</p>}
    </div>
  );
}

export function Section({ title, children, className, action }: { title?: React.ReactNode; children: React.ReactNode; className?: string; action?: React.ReactNode }) {
  return (
    <section className={cn('space-y-3', className)}>
      {(title || action) && (
        <div className="flex items-center justify-between">
          {title && <h3 className="label-mono">{title}</h3>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Panel({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('bg-panel border border-line rounded-md', className)} {...rest}>
      {children}
    </div>
  );
}

export interface SegmentedOption<T extends string | number> {
  value: T;
  label: React.ReactNode;
  title?: string;
}

export function Segmented<T extends string | number>({
  value,
  onChange,
  options,
  className,
  size = 'md',
}: {
  value: T;
  onChange: (value: T) => void;
  options: SegmentedOption<T>[];
  className?: string;
  size?: 'sm' | 'md';
}) {
  return (
    <div role="radiogroup" className={cn('flex p-0.5 bg-sunken border border-line rounded', className)}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={active}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={cn(
              'flex-1 inline-flex items-center justify-center gap-1.5 rounded-[3px] font-medium transition-colors whitespace-nowrap',
              size === 'sm' ? 'h-6 px-2 text-2xs' : 'h-7 px-2.5 text-xs',
              active ? 'bg-panel text-ink shadow-[0_0_0_1px_rgb(var(--line-strong))]' : 'text-muted hover:text-ink'
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: React.ReactNode;
  hint?: React.ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className={cn('flex items-start gap-2.5 cursor-pointer select-none', disabled && 'opacity-50 cursor-not-allowed')}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 w-3.5 h-3.5 shrink-0"
      />
      <span className="min-w-0">
        <span className="block text-sm text-ink leading-tight">{label}</span>
        {hint && <span className="block text-2xs text-muted mt-0.5 leading-snug">{hint}</span>}
      </span>
    </label>
  );
}

export function Slider({
  value,
  onChange,
  min,
  max,
  step = 1,
  format,
  label,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  format?: (v: number) => string;
  label: React.ReactNode;
}) {
  const id = useId();
  return (
    <Field label={label} htmlFor={id} aside={format ? format(value) : value}>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full h-4"
      />
    </Field>
  );
}

export function ColorInput({ value, onChange, label }: { value: string; onChange: (v: string) => void; label?: string }) {
  return (
    <label className="inline-flex items-center gap-2 h-8 px-1.5 pr-2.5 border border-line-strong rounded bg-panel hover:border-muted cursor-pointer">
      <span className="relative w-5 h-5 rounded-sm border border-line-strong overflow-hidden" style={{ backgroundColor: value }}>
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 opacity-0 cursor-pointer"
          aria-label={label ?? 'Color'}
        />
      </span>
      <span className="font-mono text-2xs uppercase text-muted">{value}</span>
    </label>
  );
}

type NoticeTone = 'info' | 'warn' | 'error' | 'ok';

export function Notice({ tone = 'info', title, children, className }: { tone?: NoticeTone; title?: React.ReactNode; children?: React.ReactNode; className?: string }) {
  const Icon = tone === 'error' ? XCircle : tone === 'warn' ? AlertTriangle : tone === 'ok' ? CheckCircle2 : Info;
  const color = tone === 'error' ? 'text-danger border-l-danger' : tone === 'warn' ? 'text-warn border-l-warn' : tone === 'ok' ? 'text-ok border-l-ok' : 'text-muted border-l-line-strong';
  return (
    <div className={cn('flex gap-2.5 p-3 bg-panel border border-line border-l-2 rounded text-xs', color, className)}>
      <Icon className="w-4 h-4 shrink-0 mt-px" />
      <div className="min-w-0 text-ink space-y-0.5">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className="text-muted leading-relaxed break-words">{children}</div>}
      </div>
    </div>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="inline-flex items-center h-5 px-1.5 font-mono text-2xs text-muted border border-line-strong rounded-sm bg-panel">{children}</kbd>;
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('w-4 h-4 animate-spin text-muted', className)} />;
}

export function ProgressLine({ progress, stage, indeterminate }: { progress: number; stage?: string; indeterminate?: boolean }) {
  const pct = Math.max(0, Math.min(100, Math.round(progress)));
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="truncate text-ink">{stage || 'Working…'}</span>
        {!indeterminate && <span className="font-mono text-2xs text-muted tabular-nums">{pct}%</span>}
      </div>
      <div className="h-1 bg-sunken rounded-full overflow-hidden">
        {indeterminate ? (
          <div className="h-full w-2/5 bg-ink animate-progress-indeterminate" />
        ) : (
          <div className="h-full bg-ink transition-[width] duration-300" style={{ width: `${pct}%` }} />
        )}
      </div>
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 420,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('input, button, textarea, select')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-ink/40" onMouseDown={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        className="w-full bg-panel border border-line-strong rounded-md shadow-float"
        style={{ maxWidth: width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 h-11 border-b border-line">
          <h2 className="text-sm font-semibold">{title}</h2>
          <IconButton label="Close" size="sm" onClick={onClose}>
            <X className="w-4 h-4" />
          </IconButton>
        </div>
        <div className="p-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 px-4 py-3 border-t border-line bg-paper/50">{footer}</div>}
      </div>
    </div>
  );
}

export function EmptyState({ icon, title, children }: { icon?: React.ReactNode; title: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-12 px-6 text-muted">
      {icon && <div className="mb-3 text-faint">{icon}</div>}
      <p className="text-sm font-medium text-ink">{title}</p>
      {children && <div className="text-xs mt-1 max-w-sm">{children}</div>}
    </div>
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 2 : 1)} MB`;
}
