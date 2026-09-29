/**
 * A grid of equal-sized tiles that only puts the rows near the viewport in
 * the page. A 5,000-page document is a few dozen tiles in the DOM instead of
 * 5,000, so scrolling, clicking and progress updates stay instant.
 * Scrolls with the window, or with the nearest scrollable ancestor.
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

interface VirtualGridProps {
  count: number;
  /** Narrowest a column may be (like CSS minmax(minColWidth, 1fr)). */
  minColWidth: number;
  /** Height of one tile, px. */
  rowHeight: number;
  gapX?: number;
  gapY?: number;
  /** Extra rows kept above and below the visible ones. */
  overscan?: number;
  className?: string;
  children: (index: number) => React.ReactNode;
}

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

export const VirtualGrid: React.FC<VirtualGridProps> = ({ count, minColWidth, rowHeight, gapX = 16, gapY = 24, overscan = 3, className, children }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [range, setRange] = useState<[number, number]>([0, 12]);

  const cols = Math.max(1, Math.floor((width + gapX) / (minColWidth + gapX)));
  const rows = Math.ceil(count / cols);
  const stride = rowHeight + gapY;

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const parent = scrollParent(el);
    const viewTop = parent ? parent.getBoundingClientRect().top : 0;
    const viewBottom = parent ? parent.getBoundingClientRect().bottom : window.innerHeight;
    const first = Math.max(0, Math.floor((viewTop - box.top) / stride) - overscan);
    const last = Math.min(rows, Math.ceil((viewBottom - box.top) / stride) + overscan);
    setRange((r) => (r[0] === first && r[1] === last ? r : [first, Math.max(first, last)]));
  }, [rows, stride, overscan]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    update();
    const parent = scrollParent(ref.current);
    const target: HTMLElement | Window = parent ?? window;
    target.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      target.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [update]);

  const [firstRow, lastRow] = range;
  const start = firstRow * cols;
  const end = Math.min(count, lastRow * cols);
  const items: React.ReactNode[] = [];
  for (let i = start; i < end; i++) items.push(<React.Fragment key={i}>{children(i)}</React.Fragment>);

  return (
    <div ref={ref} className={className} style={{ position: 'relative', height: rows ? rows * stride - gapY : 0 }}>
      <div
        style={{
          position: 'absolute',
          top: firstRow * stride,
          left: 0,
          right: 0,
          display: 'grid',
          gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
          columnGap: gapX,
          rowGap: gapY,
          gridAutoRows: rowHeight,
        }}
      >
        {items}
      </div>
    </div>
  );
};
