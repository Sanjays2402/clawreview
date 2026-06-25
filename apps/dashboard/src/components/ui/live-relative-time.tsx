'use client';

import { useEffect, useRef, useState } from 'react';

import { formatRelative } from '@/lib/format';

export interface LiveRelativeTimeProps {
  /** ISO timestamp to render relative to "now". */
  iso?: string;
  /** Refresh cadence in ms while the element is on-screen. Default 30s. */
  intervalMs?: number;
  className?: string;
  /** Optional title override; defaults to the absolute local date-time. */
  title?: string;
}

/**
 * A "3m ago" timestamp that stays fresh on a left-open tab.
 *
 * SSR-safe: the first client render reproduces exactly what the server
 * rendered (`formatRelative(iso)` is deterministic for a given clock second),
 * so hydration never mismatches. After mount it re-formats on an interval.
 *
 * Intersection-gated: the timer only runs while the element is actually in
 * the viewport, so a long table with hundreds of rows scrolled off-screen
 * doesn't churn the main thread. When the row scrolls back in, it refreshes
 * immediately and resumes ticking.
 */
export function LiveRelativeTime({
  iso,
  intervalMs = 30_000,
  className,
  title,
}: LiveRelativeTimeProps) {
  const [text, setText] = useState(() => formatRelative(iso));
  const ref = useRef<HTMLTimeElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    let timer: ReturnType<typeof setInterval> | null = null;

    function refresh() {
      setText(formatRelative(iso));
    }
    function start() {
      if (timer != null) return;
      refresh();
      timer = setInterval(refresh, intervalMs);
    }
    function stop() {
      if (timer != null) {
        clearInterval(timer);
        timer = null;
      }
    }

    // No IntersectionObserver (older/test environments): just tick always.
    if (!el || typeof IntersectionObserver === 'undefined') {
      start();
      return stop;
    }

    const obs = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting) start();
        else stop();
      },
      { rootMargin: '64px' },
    );
    obs.observe(el);
    return () => {
      obs.disconnect();
      stop();
    };
  }, [iso, intervalMs]);

  const absolute = title ?? (iso ? new Date(iso).toLocaleString() : undefined);

  return (
    <time ref={ref} dateTime={iso} title={absolute} className={className} suppressHydrationWarning>
      {text}
    </time>
  );
}
