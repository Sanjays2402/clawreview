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
  // Resolve the effective theme before first paint so there's no flash:
  //   'light' / 'dark'  -> explicit choice, applied verbatim
  //   'system' / unset  -> follow the OS via prefers-color-scheme
  // Legacy stores only ever wrote 'light' | 'dark', so unset falling through
  // to system is the only behavior change (and the intended one).
  const script = `
    try {
      var stored = localStorage.getItem('clawreview-theme');
      var dark;
      if (stored === 'light') dark = false;
      else if (stored === 'dark') dark = true;
      else dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.classList.toggle('dark', dark);
    } catch (_) {}
  `;
  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}
