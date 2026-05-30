import type { Metadata } from 'next';
import { JetBrains_Mono, Inter_Tight } from 'next/font/google';
import type { ReactNode } from 'react';

import './globals.css';

const sans = Inter_Tight({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
  weight: ['400', '500', '600', '700'],
});

const mono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
  weight: ['400', '500', '600'],
});

export const metadata: Metadata = {
  title: 'clawreview',
  description: 'Multi-agent PR review. Fast, terse, keyboard-first.',
  metadataBase: new URL('http://localhost:3000'),
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <body className="min-h-screen bg-bg font-sans text-fg antialiased">
        <ThemeBoot />
        {children}
      </body>
    </html>
  );
}

function ThemeBoot() {
  const script = `
    try {
      const stored = localStorage.getItem('clawreview-theme');
      const theme = stored || 'dark';
      document.documentElement.classList.toggle('dark', theme !== 'light');
    } catch (_) {}
  `;
  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}
