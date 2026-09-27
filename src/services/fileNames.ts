/** File-name helpers for saving results (see components/common/AutoSave). */

export const AUTOSAVE_SECONDS = 5;

export function splitFileName(name: string): { base: string; ext: string } {
  const m = /^(.*?)(\.[A-Za-z0-9]{1,5})?$/.exec(name.trim());
  return { base: m?.[1] || 'document', ext: m?.[2] ?? '' };
}

/** Removes characters Windows/macOS don't allow in file names. */
export function cleanFileName(base: string): string {
  // eslint-disable-next-line no-control-regex
  return base.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 180);
}

const ids = new WeakMap<object, number>();
let nextId = 1;
/** A stable number per object, for keying <AutoSave> to a specific result. */
export function resultKey(obj: object | null | undefined): number {
  if (!obj) return 0;
  let id = ids.get(obj);
  if (!id) {
    id = nextId++;
    ids.set(obj, id);
  }
  return id;
}
