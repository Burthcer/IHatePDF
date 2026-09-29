/**
 * Appending many pages at once. pdf-lib's addPage() walks the page tree for
 * every page it adds, so building a 10,000-page document spends seconds in
 * that walk alone. When the document's page tree is flat (a document made
 * with PDFDocument.create() that only ever had pages appended), the pages can
 * be added to the root's /Kids directly.
 */

import { PDFArray, PDFName, PDFNumber, PDFPage, PDFPageLeaf, PDFRef, type PDFDocument } from 'pdf-lib';

interface DocInternals {
  pageCache: { invalidate(): void };
  pageMap: Map<PDFPageLeaf, PDFPage>;
}

/** A new, empty page of `size` points, not yet in the page tree (see appendPages). */
export function newPage(doc: PDFDocument, size: [number, number]): PDFPage {
  const page = PDFPage.create(doc);
  page.setSize(size[0], size[1]);
  return page;
}

/** Appends `pages` (already copied into `doc`, not yet added) at the end, in order. */
export function appendPages(doc: PDFDocument, pages: PDFPage[]): void {
  const rootRef = doc.catalog.get(PDFName.of('Pages'));
  const root = doc.catalog.Pages();
  const kids = root.Kids();
  const flat = rootRef instanceof PDFRef && kids instanceof PDFArray && kids.asArray().every((k) => doc.context.lookup(k) instanceof PDFPageLeaf);
  if (!flat) {
    pages.forEach((p) => doc.addPage(p));
    return;
  }
  const internals = doc as unknown as DocInternals;
  for (const page of pages) {
    page.node.setParent(rootRef as PDFRef);
    kids.push(page.ref);
    internals.pageMap.set(page.node, page);
  }
  root.set(PDFName.of('Count'), PDFNumber.of(kids.size()));
  internals.pageCache.invalidate();
}
