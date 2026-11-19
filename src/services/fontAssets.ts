/**
 * Desktop app: where the Unicode fonts sit among the app's embedded files, as URL paths. The Rust engine
 * (`run_tool`, args.fontAssets) reads them from the app's assets for Watermark and Page numbers in
 * scripts the 14 standard fonts can't draw. Order per face: regular, bold, (italic, bold italic).
 */
const p = (u: URL) => u.pathname;

export const fontAssets = () => ({
  liberation: [
    p(new URL('../../node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf', import.meta.url)),
    p(new URL('../../node_modules/pdfjs-dist/standard_fonts/LiberationSans-Bold.ttf', import.meta.url)),
    p(new URL('../../node_modules/pdfjs-dist/standard_fonts/LiberationSans-Italic.ttf', import.meta.url)),
    p(new URL('../../node_modules/pdfjs-dist/standard_fonts/LiberationSans-BoldItalic.ttf', import.meta.url)),
  ],
  devanagari: [p(new URL('../assets/fonts/NotoSansDevanagari-Regular.ttf', import.meta.url)), p(new URL('../assets/fonts/NotoSansDevanagari-Bold.ttf', import.meta.url))],
  cjk: [p(new URL('../assets/fonts/NotoSansSC-Regular.ttf', import.meta.url)), p(new URL('../assets/fonts/NotoSansSC-Bold.ttf', import.meta.url))],
});
