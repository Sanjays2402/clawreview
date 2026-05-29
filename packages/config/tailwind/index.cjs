/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: 'hsl(var(--bg))',
          subtle: 'hsl(var(--bg-subtle))',
          muted: 'hsl(var(--bg-muted))',
        },
        fg: {
          DEFAULT: 'hsl(var(--fg))',
          muted: 'hsl(var(--fg-muted))',
          subtle: 'hsl(var(--fg-subtle))',
        },
        border: {
          DEFAULT: 'hsl(var(--border))',
          subtle: 'hsl(var(--border-subtle))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          fg: 'hsl(var(--accent-fg))',
        },
        severity: {
          critical: 'hsl(0 84% 60%)',
          high: 'hsl(20 90% 55%)',
          medium: 'hsl(38 92% 50%)',
          low: 'hsl(200 90% 55%)',
          nit: 'hsl(220 10% 60%)',
        },
      },
      fontFamily: {
        sans: ['var(--font-geist-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-geist-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      borderRadius: {
        lg: '0.625rem',
      },
      keyframes: {
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
        'fade-in': {
          '0%': { opacity: '0', transform: 'translateY(2px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        shimmer: 'shimmer 1.4s infinite',
        'fade-in': 'fade-in 180ms ease-out',
      },
    },
  },
  plugins: [],
};
