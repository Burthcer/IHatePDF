/**
 * Drawing on pages "as the reader sees them".
 *
 * pdf-lib coordinates are raw user space: they ignore /Rotate and assume
 * the visible area starts at (0,0). On a rotated or cropped page, a footer
 * drawn at y=20 ends up sideways or off-page. `withViewerFrame` sets up a
 * coordinate system whose origin is the bottom-left of the page as
 * displayed, sized to the displayed width/height, so stamps land where
 * they appear in the preview.
 */

import { concatTransformationMatrix, popGraphicsState, pushGraphicsState, type PDFPage } from 'pdf-lib';
import { userToViewer, viewerFrameToUser } from '../features/editPdf/engine/geometry';

export function viewerSize(page: PDFPage): { width: number; height: number } {
  const { width, height } = userToViewer(page);
  return { width, height };
}

export function withViewerFrame<T>(page: PDFPage, draw: (size: { width: number; height: number }) => T): T {
  const m = viewerFrameToUser(page);
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(m[0], m[1], m[2], m[3], m[4], m[5]));
  try {
    return draw(viewerSize(page));
  } finally {
    page.pushOperators(popGraphicsState());
  }
}
