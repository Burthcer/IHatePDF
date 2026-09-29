import React from 'react';
import { cn } from '../ui';

interface PageThumbProps {
  src?: string;
  /** Page aspect (width / height) as rendered. */
  aspect: number;
  label?: React.ReactNode;
  selected?: boolean;
  dimmed?: boolean;
  /** Extra rotation to preview, in degrees. */
  rotate?: number;
  onClick?: (e: React.MouseEvent | React.KeyboardEvent) => void;
  className?: string;
  children?: React.ReactNode;
  width?: number;
  /** usePageThumbnails' thumbRef(i): draws the thumbnail when the tile scrolls into view. */
  viewRef?: (el: Element | null) => void;
}

/** A page thumbnail tile: white page in a fixed cell, label underneath. */
export const PageThumb: React.FC<PageThumbProps> = ({ src, aspect, label, selected, dimmed, rotate = 0, onClick, className, children, width = 132, viewRef }) => {
  const cellH = width * 1.3;
  const turned = Math.abs(rotate % 180) === 90;
  const visualAspect = turned ? 1 / aspect : aspect;
  let vw = width;
  let vh = width / visualAspect;
  if (vh > cellH) {
    vh = cellH;
    vw = cellH * visualAspect;
  }
  const iw = turned ? vh : vw;
  const ih = turned ? vw : vh;

  return (
    <div ref={viewRef} className={cn('flex flex-col items-center gap-1.5', className)}>
      <div
        role={onClick ? 'button' : undefined}
        tabIndex={onClick ? 0 : undefined}
        onClick={onClick}
        onKeyDown={(e) => {
          if (onClick && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            onClick(e);
          }
        }}
        className={cn('relative', onClick && 'cursor-pointer')}
        style={{ width, height: cellH }}
      >
        <div
          className={cn(
            'absolute left-1/2 top-1/2 bg-white shadow-page transition-transform duration-200',
            selected && 'outline outline-2 outline-accent outline-offset-2',
            dimmed && 'opacity-35'
          )}
          style={{ width: iw, height: ih, transform: `translate(-50%, -50%) rotate(${rotate}deg)` }}
        >
          {src && <img src={src} alt="" draggable={false} className="w-full h-full object-fill block" />}
        </div>
        {children}
      </div>
      {label !== undefined && <div className="font-mono text-2xs text-muted">{label}</div>}
    </div>
  );
};
