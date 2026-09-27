// pdf.js's own worker (legacy build: bundles polyfills for newer JS APIs
// such as Math.sumPrecise), with the upsert polyfill installed first.
import './polyfills';
import 'pdfjs-dist/legacy/build/pdf.worker.min.mjs';
