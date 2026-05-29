const base = require('@clawreview/config/tailwind');

/** @type {import('tailwindcss').Config} */
module.exports = {
  ...base,
  content: [
    './src/**/*.{ts,tsx,js,jsx,md,mdx}',
    '../../packages/ui/src/**/*.{ts,tsx}',
  ],
};
