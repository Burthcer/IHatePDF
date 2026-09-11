/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        canvas: {
          // Barely-off-white / near-black page background, distinct from the
          // pure-white / slate-900 cards sitting on top of it — the subtle
          // gap between the two is what reads as depth instead of flatness.
          light: '#FAFAF9',
          dark: '#020617',
        },
        // Brand identity — a real red scale (not a flat hex), used for the
        // primary CTA, selection color, and anything that should read as
        // "this app", as opposed to `tool.*` in constants/tools.ts, which
        // color-codes individual features and changes per card.
        brand: {
          50: '#FEF2F2',
          100: '#FEE2E2',
          400: '#F87171',
          500: '#EF4444',
          600: '#DC2626',
          700: '#B91C1C',
          900: '#7F1D1D',
        },
      },
      boxShadow: {
        // Soft, diffused elevation in place of a harsh 1px border.
        soft: '0 1px 2px rgba(15, 23, 42, 0.04), 0 8px 24px -8px rgba(15, 23, 42, 0.10)',
        'soft-lg': '0 2px 8px rgba(15, 23, 42, 0.06), 0 24px 48px -16px rgba(15, 23, 42, 0.18)',
        'soft-dark': '0 1px 2px rgba(0, 0, 0, 0.3), 0 8px 24px -8px rgba(0, 0, 0, 0.5)',
        'soft-dark-lg': '0 2px 8px rgba(0, 0, 0, 0.4), 0 24px 48px -16px rgba(0, 0, 0, 0.65)',
      },
      transitionTimingFunction: {
        'out-expo': 'cubic-bezier(0.16, 1, 0.3, 1)',
        spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
      },
    },
  },
  plugins: [],
}
