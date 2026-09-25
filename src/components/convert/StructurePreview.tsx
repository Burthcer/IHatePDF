import React from 'react';
import type { PageLayout, StyledRun } from '../../services/textLayout';

function Runs({ runs }: { runs: StyledRun[] }) {
  return (
    <>
      {runs.map((r, i) => {
        let node: React.ReactNode = r.text;
        if (r.italic) node = <em>{node}</em>;
        if (r.bold) node = <strong>{node}</strong>;
        if (r.mono) node = <code className="font-mono text-[0.92em]">{node}</code>;
        return <React.Fragment key={i}>{node}</React.Fragment>;
      })}
    </>
  );
}

/** Renders the recovered document structure — what the Word/Markdown output will contain. */
export const StructurePreview: React.FC<{ pages: PageLayout[]; maxPages?: number }> = ({ pages, maxPages = 3 }) => (
  <div className="bg-white text-[#1b1b1b] border border-line rounded-md shadow-page px-8 py-7 max-h-[70vh] overflow-y-auto scroll-thin space-y-3 text-[13px] leading-relaxed font-serif">
    {pages.slice(0, maxPages).map((p) => (
      <section key={p.pageNumber} className="space-y-3">
        <p className="font-mono text-[10px] text-[#9a968c] uppercase tracking-wider border-b border-[#eee] pb-1">Page {p.pageNumber}</p>
        {p.blocks.length === 0 && <p className="text-[#9a968c] italic">No text on this page.</p>}
        {p.blocks.map((b, i) => {
          switch (b.kind) {
            case 'heading': {
              const cls = b.level === 1 ? 'text-xl font-bold' : b.level === 2 ? 'text-lg font-bold' : 'text-[15px] font-semibold';
              return (
                <p key={i} className={`${cls} font-sans`}>
                  {b.text}
                </p>
              );
            }
            case 'paragraph':
              return (
                <p key={i} style={{ textAlign: b.align }}>
                  <Runs runs={b.runs} />
                </p>
              );
            case 'list': {
              const Tag = b.ordered ? 'ol' : 'ul';
              return (
                <Tag key={i} className={`${b.ordered ? 'list-decimal' : 'list-disc'} pl-6 space-y-0.5`}>
                  {b.items.map((it, k) => (
                    <li key={k}>
                      <Runs runs={it.runs} />
                    </li>
                  ))}
                </Tag>
              );
            }
            case 'table':
              return (
                <table key={i} className="w-full border-collapse text-[12px] font-sans">
                  <tbody>
                    {b.rows.map((row, r) => (
                      <tr key={r}>
                        {row.map((cell, c) => (
                          <td key={c} className={`border border-[#d7d3c8] px-2 py-1 align-top ${r === 0 ? 'font-semibold bg-[#f6f5f1]' : ''}`}>
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              );
          }
        })}
      </section>
    ))}
    {pages.length > maxPages && <p className="font-mono text-[10px] text-[#9a968c]">… {pages.length - maxPages} more pages</p>}
  </div>
);
