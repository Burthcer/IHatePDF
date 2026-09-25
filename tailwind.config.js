/** @type {import('tailwindcss').Config} */
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Semantic tokens — values live in src/index.css (light + dark).
        paper: token('paper'),
        panel: token('panel'),
        sunken: token('sunken'),
        ink: token('ink'),
        muted: token('muted'),
        faint: token('faint'),
        line: token('line'),
        'line-strong': token('line-strong'),
        hover: token('hover'),
        accent: token('accent'),
        'accent-ink': token('accent-ink'),
        'accent-soft': token('accent-soft'),
        danger: token('danger'),
        ok: token('ok'),
        warn: token('warn'),
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      borderRadius: {
        DEFAULT: '4px',
        md: '6px',
        lg: '8px',
      },
      boxShadow: {
        float: '0 1px 0 rgb(0 0 0 / 0.04), 0 8px 24px -6px rgb(0 0 0 / 0.18)',
        page: '0 0 0 1px rgb(0 0 0 / 0.06), 0 2px 6px rgb(0 0 0 / 0.08)',
      },
    },
  },
  plugins: [],
};
