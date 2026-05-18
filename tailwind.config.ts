import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // Marketing site (preserved — DO NOT TOUCH)
        ivory: '#F5F0E8',
        champagne: {
          DEFAULT: '#C9A96E',
          light: '#D4B896',
          dark: '#A8894D',
        },
        // Dashboard — enterprise navy/slate/blue system
        dashboard: {
          bg:           '#F4F6FB',         // page background, cool slate
          shell:        '#FFFFFF',         // opaque white shell
          card:         '#FFFFFF',
          surface:      '#F8FAFC',         // slate-50 — hover, zebra, info chips
          surfaceAlt:   '#F1F5F9',         // slate-100 — AI bubbles, soft fills
          border:       '#E2E8F0',         // slate-200 — primary border
          borderStrong: '#CBD5E1',         // slate-300 — emphasized border
          divider:      '#F1F5F9',         // slate-100 — table dividers

          text:          '#0F172A',        // slate-900
          textSecondary: '#475569',        // slate-600
          textMuted:     '#64748B',        // slate-500
          textFaint:     '#94A3B8',        // slate-400

          navy:      '#0F172A',            // primary CTA, headings
          navyHover: '#1E293B',
          blue:      '#1D4ED8',            // accent (premium, restrained)
          blueHover: '#1E40AF',
          blueSoft:  '#EFF6FF',
          blueRing:  '#3B82F6',

          green:     '#059669',            // emerald-600
          greenSoft: '#ECFDF5',
          amber:     '#D97706',
          amberSoft: '#FFFBEB',
          red:       '#DC2626',
          redSoft:   '#FEF2F2',
        },
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'system-ui', 'sans-serif'],
        display: ['var(--font-playfair)', 'Georgia', 'serif'],
        cormorant: ['var(--font-cormorant)', 'Georgia', 'serif'],
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
        'navy-blue':       'linear-gradient(135deg, #0F172A 0%, #1E3A8A 100%)',
      },
      boxShadow: {
        'glass':      '0 20px 50px rgba(15, 23, 42, 0.10), 0 6px 16px rgba(15, 23, 42, 0.04)',
        'card':       '0 1px 2px rgba(15, 23, 42, 0.04), 0 2px 8px rgba(15, 23, 42, 0.03)',
        'card-hover': '0 4px 14px rgba(15, 23, 42, 0.08), 0 10px 30px rgba(15, 23, 42, 0.05)',
      },
      animation: {
        'float': 'float 5s ease-in-out infinite',
        'float-slow': 'float 7s ease-in-out infinite',
        'pulse-glow': 'pulse-glow 4s ease-in-out infinite',
        'marquee': 'marquee 30s linear infinite',
        'fade-in': 'fade-in 0.4s ease-out',
        'slide-up': 'slide-up 0.4s ease-out',
        'blob': 'blob 18s ease-in-out infinite',
      },
      keyframes: {
        float: {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%': { transform: 'translateY(-12px)' },
        },
        'pulse-glow': {
          '0%, 100%': { opacity: '0.4' },
          '50%': { opacity: '0.8' },
        },
        marquee: {
          '0%': { transform: 'translateX(0%)' },
          '100%': { transform: 'translateX(-50%)' },
        },
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        blob: {
          '0%, 100%': { transform: 'translate(0, 0) scale(1)' },
          '33%':      { transform: 'translate(40px, -30px) scale(1.05)' },
          '66%':      { transform: 'translate(-30px, 30px) scale(0.95)' },
        },
      },
    },
  },
  plugins: [],
}
export default config
