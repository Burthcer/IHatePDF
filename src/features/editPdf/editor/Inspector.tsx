import React from 'react';
import { AlignCenter, AlignJustify, AlignLeft, AlignRight, Bold, Italic, RotateCcw, Trash2 } from 'lucide-react';
import type { EditorPageAnalysis } from '../editPdf.worker';
import { Button, ColorInput, Field, IconButton, Notice, Section, Segmented, Slider } from '../../../components/ui';
import { imageKey, type DocEdits, type EditStyle, type Selection } from './types';
import { selectionRect } from './geometry';

interface InspectorProps {
  pageIndex: number;
  analysis: EditorPageAnalysis | null;
  edits: DocEdits;
  selection: Selection;
  onCommit: (updater: (d: DocEdits) => DocEdits, coalesceKey?: string) => void;
  onDelete: () => void;
  onStartEdit: (sel: Selection) => void;
  onStyleUsed: (style: EditStyle) => void;
}

function TextStyleControls({
  style,
  allowOriginal,
  fontLabel,
  onChange,
}: {
  style: EditStyle;
  allowOriginal: boolean;
  fontLabel?: string;
  onChange: (patch: Partial<EditStyle>) => void;
}) {
  const familyOptions = [
    ...(allowOriginal ? [{ value: 'original' as const, label: 'Original' }] : []),
    { value: 'sans' as const, label: 'Sans' },
    { value: 'serif' as const, label: 'Serif' },
    { value: 'mono' as const, label: 'Mono' },
  ];
  return (
    <div className="space-y-4">
      <Field label="Font" hint={style.fontChoice === 'original' && fontLabel ? fontLabel : undefined}>
        <Segmented
          value={style.fontChoice}
          onChange={(v) => onChange({ fontChoice: v, ...(v !== 'original' ? { family: v } : {}) })}
          options={familyOptions}
          size="sm"
        />
      </Field>
      <div className="flex items-end gap-2">
        <Field label="Size" className="w-20">
          <input
            type="number"
            min={4}
            max={300}
            step={0.5}
            className="input font-mono"
            value={Math.round(style.fontSize * 10) / 10}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (v >= 1 && v <= 500) onChange({ fontSize: v });
            }}
          />
        </Field>
        <div className="flex gap-1 pb-px">
          <IconButton label="Bold" active={style.bold} onClick={() => onChange({ bold: !style.bold })}>
            <Bold className="w-4 h-4" />
          </IconButton>
          <IconButton label="Italic" active={style.italic} onClick={() => onChange({ italic: !style.italic })}>
            <Italic className="w-4 h-4" />
          </IconButton>
        </div>
      </div>
      <Field label="Color">
        <ColorInput value={style.color} onChange={(color) => onChange({ color })} />
      </Field>
      <Field label="Alignment">
        <Segmented
          value={style.align}
          onChange={(align) => onChange({ align })}
          size="sm"
          options={[
            { value: 'left', label: <AlignLeft className="w-3.5 h-3.5" />, title: 'Left' },
            { value: 'center', label: <AlignCenter className="w-3.5 h-3.5" />, title: 'Center' },
            { value: 'right', label: <AlignRight className="w-3.5 h-3.5" />, title: 'Right' },
            { value: 'justify', label: <AlignJustify className="w-3.5 h-3.5" />, title: 'Justify' },
          ]}
        />
      </Field>
    </div>
  );
}

export const Inspector: React.FC<InspectorProps> = ({ pageIndex, analysis, edits, selection, onCommit, onDelete, onStartEdit, onStyleUsed }) => {
  if (!selection) {
    return (
      <div className="p-4 space-y-4 text-xs text-muted leading-relaxed">
        <Section title="Editing text">
          <p>
            Double-click any text on the page to retype it. The paragraph reflows like in a word processor, and the
            original characters are removed from the file — not covered up.
          </p>
          <p>Drag text or images to move them. Drag the side handles of a paragraph to change its width.</p>
        </Section>
        <Section title="Shortcuts">
          <ul className="space-y-1 font-mono text-2xs">
            <li>V select · T text · I image · W whiteout</li>
            <li>R rectangle · E ellipse · L line · H highlight</li>
            <li>Del delete · ⌘Z undo · ⇧⌘Z redo</li>
            <li>Arrows nudge (⇧ ×10) · Esc deselect</li>
          </ul>
        </Section>
      </div>
    );
  }

  const rect = selectionRect(selection, analysis, edits, pageIndex);
  const deleteButton = (
    <Button variant="danger" size="sm" icon={<Trash2 className="w-3.5 h-3.5" />} onClick={onDelete}>
      Delete
    </Button>
  );

  if (selection.kind === 'block') {
    const block = analysis?.blocks.find((b) => b.id === selection.id);
    if (!block) return null;
    const edit = edits.blocks[block.id];
    const style: EditStyle = { ...block.style, fontChoice: 'original', ...edit?.style };
    const fontLabel = `${block.fontName}${block.fontEmbedded ? (block.fontSubset ? ' · embedded subset' : ' · embedded') : ' · not embedded'}`;
    const update = (patch: Partial<EditStyle>) => {
      onCommit((d) => {
        const prev = d.blocks[block.id] ?? { id: block.id, pageIndex };
        return { ...d, blocks: { ...d.blocks, [block.id]: { ...prev, style: { ...prev.style, ...patch } } } };
      }, `style:${block.id}:${Object.keys(patch).join(',')}`);
      onStyleUsed({ ...style, ...patch });
    };
    return (
      <div className="p-4 space-y-5">
        <Section title="Paragraph" action={deleteButton}>
          {!block.editable && <Notice tone="warn">{block.reason}</Notice>}
          {block.editable && (
            <Field label="Text" hint="Or double-click it on the page. Blank lines separate paragraphs.">
              <textarea
                className="input min-h-[96px] text-xs"
                value={edit?.text ?? block.text}
                onChange={(e) => {
                  const text = e.target.value;
                  onCommit((d) => {
                    const prev = d.blocks[block.id] ?? { id: block.id, pageIndex };
                    return { ...d, blocks: { ...d.blocks, [block.id]: { ...prev, text } } };
                  }, `text:${block.id}`);
                }}
              />
            </Field>
          )}
          {block.editable && block.angle === 0 && (
            <Button size="sm" onClick={() => onStartEdit(selection)}>
              Edit on page
            </Button>
          )}
        </Section>
        {block.editable && (
          <Section title="Style">
            <TextStyleControls style={style} allowOriginal fontLabel={fontLabel} onChange={update} />
          </Section>
        )}
        {edit && (
          <Button
            size="sm"
            variant="ghost"
            icon={<RotateCcw className="w-3.5 h-3.5" />}
            onClick={() =>
              onCommit((d) => {
                const blocks = { ...d.blocks };
                delete blocks[block.id];
                return { ...d, blocks };
              })
            }
          >
            Revert to original
          </Button>
        )}
      </div>
    );
  }

  if (selection.kind === 'text') {
    const t = edits.texts.find((x) => x.id === selection.id);
    if (!t) return null;
    const update = (patch: Partial<EditStyle>) => {
      onCommit((d) => ({ ...d, texts: d.texts.map((x) => (x.id === t.id ? { ...x, style: { ...x.style, ...patch } } : x)) }), `style:${t.id}:${Object.keys(patch).join(',')}`);
      onStyleUsed({ ...t.style, ...patch });
    };
    return (
      <div className="p-4 space-y-5">
        <Section title="Text box" action={deleteButton}>
          <Field label="Text">
            <textarea
              className="input min-h-[80px] text-xs"
              value={t.text}
              onChange={(e) => {
                const text = e.target.value;
                onCommit((d) => ({ ...d, texts: d.texts.map((x) => (x.id === t.id ? { ...x, text } : x)) }), `text:${t.id}`);
              }}
            />
          </Field>
        </Section>
        <Section title="Style">
          <TextStyleControls style={t.style} allowOriginal={false} onChange={update} />
        </Section>
      </div>
    );
  }

  if (selection.kind === 'shape') {
    const s = edits.shapes.find((x) => x.id === selection.id);
    if (!s) return null;
    const update = (patch: Partial<typeof s>) =>
      onCommit((d) => ({ ...d, shapes: d.shapes.map((x) => (x.id === s.id ? { ...x, ...patch } : x)) }), `shape:${s.id}:${Object.keys(patch).join(',')}`);
    const label = s.kind === 'highlight' ? 'Highlight' : s.kind === 'line' ? 'Line' : s.kind === 'ellipse' ? 'Ellipse' : 'Rectangle';
    return (
      <div className="p-4 space-y-5">
        <Section title={label} action={deleteButton}>
          {s.kind !== 'line' && (
            <Field label="Fill">
              <div className="flex items-center gap-2">
                {s.fill !== null ? (
                  <ColorInput value={s.fill} onChange={(fill) => update({ fill })} />
                ) : (
                  <span className="text-xs text-muted">None</span>
                )}
                {s.kind !== 'highlight' && (
                  <Button size="sm" variant="ghost" onClick={() => update({ fill: s.fill === null ? '#FFFFFF' : null })}>
                    {s.fill === null ? 'Add fill' : 'No fill'}
                  </Button>
                )}
              </div>
            </Field>
          )}
          {s.kind !== 'highlight' && (
            <Field label="Outline">
              <div className="flex items-center gap-2">
                {s.stroke !== null ? (
                  <ColorInput value={s.stroke} onChange={(stroke) => update({ stroke })} />
                ) : (
                  <span className="text-xs text-muted">None</span>
                )}
                {s.kind !== 'line' && (
                  <Button size="sm" variant="ghost" onClick={() => update({ stroke: s.stroke === null ? '#111111' : null, strokeWidth: s.strokeWidth || 1 })}>
                    {s.stroke === null ? 'Add outline' : 'No outline'}
                  </Button>
                )}
              </div>
            </Field>
          )}
          {s.stroke !== null && s.kind !== 'highlight' && (
            <Slider label="Line width" min={0.25} max={12} step={0.25} value={s.strokeWidth} onChange={(strokeWidth) => update({ strokeWidth })} format={(v) => `${v} pt`} />
          )}
          <Slider label="Opacity" min={0.05} max={1} step={0.05} value={s.opacity} onChange={(opacity) => update({ opacity })} format={(v) => `${Math.round(v * 100)}%`} />
        </Section>
      </div>
    );
  }

  const imageInfo =
    rect && (
      <p className="font-mono text-2xs text-muted">
        {Math.round(rect.width)} × {Math.round(rect.height)} pt
      </p>
    );

  if (selection.kind === 'image') {
    const key = imageKey(pageIndex, selection.id);
    return (
      <div className="p-4 space-y-4">
        <Section title="Image" action={deleteButton}>
          {imageInfo}
          <p className="text-xs text-muted">Drag to move. Drag a corner to resize (hold Shift to stretch freely).</p>
          {edits.images[key] && (
            <Button
              size="sm"
              variant="ghost"
              icon={<RotateCcw className="w-3.5 h-3.5" />}
              onClick={() =>
                onCommit((d) => {
                  const images = { ...d.images };
                  delete images[key];
                  return { ...d, images };
                })
              }
            >
              Revert to original
            </Button>
          )}
        </Section>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      <Section title="Added image" action={deleteButton}>
        {imageInfo}
        <p className="text-xs text-muted">Drag to move. Drag a corner to resize (hold Shift to stretch freely).</p>
      </Section>
    </div>
  );
};
