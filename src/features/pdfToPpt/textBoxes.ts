import type { TextBlock } from '../editPdf/engine/layout';
import type { PptTextBox } from '../../types/worker';

function familyFace(fontName: string, family: 'sans' | 'serif' | 'mono'): string {
  const base = fontName.split(/[-,+]/)[0].replace(/(MT|PS|Std|Pro)$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  if (base && /^[A-Za-z ]{3,40}$/.test(base)) return base;
  return family === 'serif' ? 'Times New Roman' : family === 'mono' ? 'Courier New' : 'Arial';
}

/** The paragraphs the editor engine found on a page, as PowerPoint text boxes. Mirrored in Rust (editpdf.rs `ppt_text_boxes`). */
export function blocksToPptBoxes(blocks: TextBlock[]): PptTextBox[] {
  return blocks
    .filter((b) => b.text.trim())
    .map((b) => ({
      x: b.box.x,
      y: b.box.y,
      width: b.box.width,
      height: b.box.height,
      lines: b.lines.map((l) => l.text),
      fontSize: b.style.fontSize,
      color: b.style.color,
      bold: b.style.bold,
      italic: b.style.italic,
      fontFace: familyFace(b.fontName, b.style.family),
      align: b.style.align === 'justify' ? 'left' : b.style.align,
      lineHeight: b.lines.length > 1 ? b.frame.lineHeight : undefined,
      rotate: b.angle,
    }));
}
