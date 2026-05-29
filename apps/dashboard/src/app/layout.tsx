import type { Metadata } from 'next';
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import type { ReactNode } from 'react';

import './globals.css';

export const metadata: Metadata = {
  title: 'ClawReview',
  description: 'Multi-agent AI code review for your pull requests.',
  metadataBase: new URL('http://localhost:3000'),
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <body className="min-h-screen bg-bg font-sans text-fg">
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
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const theme = stored || (prefersDark ? 'dark' : 'light');
      document.documentElement.classList.toggle('dark', theme === 'dark');
    } catch (_) {}
  `;
  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}
