import React from 'react';
import { cn } from '../ui';

interface PageThumbProps {
  src?: string;
  /** Page aspect (width / height) as rendered. */
  aspect: number;
  label?: React.ReactNode;
  selected?: boolean;
  /** Colour of the group this page belongs to (e.g. a Split part): drawn as a ring around the page. Two or more
   *  colours (a page in several groups): the first as the inner ring, the second as an outer band. */
  ring?: string | string[];
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
export const PageThumb: React.FC<PageThumbProps> = ({ src, aspect, label, selected, ring, dimmed, rotate = 0, onClick, className, children, width = 132, viewRef }) => {
  const cellH = width * 1.3;
  const turned = Math.abs(rotate % 180) === 90;
  const rings = ring === undefined ? [] : Array.isArray(ring) ? ring : [ring];
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
            selected && !rings.length && 'outline outline-2 outline-accent outline-offset-2',
            dimmed && 'opacity-35'
          )}
          style={{
            width: iw,
            height: ih,
            transform: `translate(-50%, -50%) rotate(${rotate}deg)`,
            ...(rings[0] && { outline: `${selected ? 4 : 2}px solid ${rings[0]}`, outlineOffset: 2 }),
            ...(rings[1] && { boxShadow: `0 0 0 ${selected ? 8 : 6}px ${rings[1]}` }),
          }}
        >
          {src && <img src={src} alt="" draggable={false} className="w-full h-full object-fill block" />}
        </div>
        {children}
      </div>
      {label !== undefined && <div className={cn('font-mono text-2xs text-muted whitespace-nowrap', rings.length > 0 && 'mt-1.5')}>{label}</div>}
    </div>
  );
};
