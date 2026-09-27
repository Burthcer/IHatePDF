/**
 * Word-level diff (Myers O(ND)) between two documents' text, with each word
 * remembering the page it came from.
 */

export interface Word {
  text: string;
  page: number;
}

export type DiffOp = { type: 'eq' | 'del' | 'ins'; words: Word[] };

const MAX_D = 2500; // edit distance cap; the trace costs O(D²) memory

function myers(a: string[], b: string[]): Array<'eq' | 'del' | 'ins'> | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] holds v (as it was before step d) for k in [-d-1, d+1] only
  const trace: Int32Array[] = [];
  const at = (d: number, k: number) => trace[d][k + d + 1];
  for (let d = 0; d <= Math.min(max, MAX_D); d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        // backtrack
        const ops: Array<'eq' | 'del' | 'ins'> = [];
        let cx = n;
        let cy = m;
        for (let dd = d; dd > 0; dd--) {
          const kk = cx - cy;
          const prevK = kk === -dd || (kk !== dd && at(dd, kk - 1) < at(dd, kk + 1)) ? kk + 1 : kk - 1;
          const prevX = at(dd, prevK);
          const prevY = prevX - prevK;
          while (cx > prevX && cy > prevY) {
            ops.push('eq');
            cx--;
            cy--;
          }
          ops.push(cx === prevX ? 'ins' : 'del');
          cx = prevX;
          cy = prevY;
        }
        while (cx > 0 && cy > 0) {
          ops.push('eq');
          cx--;
          cy--;
        }
        return ops.reverse();
      }
    }
  }
  return null;
}

function normalize(w: string): string {
  return w.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/­/g, '');
}

export function diffWords(a: Word[], b: Word[]): DiffOp[] | null {
  // Trim common prefix/suffix first — usually most of the document.
  let start = 0;
  while (start < a.length && start < b.length && normalize(a[start].text) === normalize(b[start].text)) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && normalize(a[endA - 1].text) === normalize(b[endB - 1].text)) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const ops = myers(midA.map((w) => normalize(w.text)), midB.map((w) => normalize(w.text)));
  if (!ops) return null;

  const out: DiffOp[] = [];
  const push = (type: DiffOp['type'], word: Word) => {
    const last = out[out.length - 1];
    if (last && last.type === type) last.words.push(word);
    else out.push({ type, words: [word] });
  };
  b.slice(0, start).forEach((w) => push('eq', w));
  let i = 0;
  let j = 0;
  for (const op of ops) {
    if (op === 'eq') {
      push('eq', midB[j]);
      i++;
      j++;
    } else if (op === 'del') push('del', midA[i++]);
    else push('ins', midB[j++]);
  }
  b.slice(endB).forEach((w) => push('eq', w));
  return out;
}
