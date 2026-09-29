/**
 * Turns low-level failures (parser internals, file-system errors) into
 * messages a person can act on. Applied to every error a tool reports.
 */

/** Parser / structure failures that mean "this file is damaged". */
const DAMAGED =
  /Cannot read propert(y|ies) of (undefined|null)|Invalid object ref|Failed to parse|Expected .{1,40} but (got|found)|No PDF header|MissingPDFHeader|PDFInvalidObject|Invalid PDF structure|trailer|xref|startxref|Unexpected end|UnexpectedObjectType|Invalid (array|dict|stream)|stream.{0,20}Length|Parse error|Bad (FCHECK|FDICT)|invalid (distance|block type|stored block|code lengths)|incorrect header check/i;

/** The picked file can no longer be read (moved, changed or deleted after adding it). */
const GONE = /NotReadableError|NotFoundError|could not be read|requested file could not be read|ENOENT|EBUSY|EPERM|EACCES/i;

/** The JS engine ran out of memory for a single allocation. */
const NO_MEMORY = /Array buffer allocation failed|allocation failed|out of memory|Invalid array length|Invalid typed array length/i;

export function friendlyError(raw: string, context?: { fileName?: string; tool?: string }): string {
  // Merge prefixes its messages with the file's name: keep it.
  const named = /^"([^"]+)" couldn't be read: /.exec(raw);
  const name = named?.[1] ?? context?.fileName;
  const message = named ? raw.slice(named[0].length) : raw;
  const which = name ? `“${name}”` : 'This file';
  if (GONE.test(message)) return `${which} can’t be read any more — it was moved, changed or deleted after you added it. Add it again.`;
  if (NO_MEMORY.test(message)) return `${which} needs more memory than this PC can spare right now. Close other programs and try again, or split it into smaller parts first.`;
  if (DAMAGED.test(message)) {
    return context?.tool === 'repair'
      ? `${which} is too damaged to rebuild: its structure couldn’t be read.`
      : `${which} is damaged — part of its structure can’t be read. Open it in Repair PDF first, then use the repaired copy here.`;
  }
  return raw;
}
