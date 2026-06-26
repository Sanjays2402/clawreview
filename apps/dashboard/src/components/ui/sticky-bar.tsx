'use client';

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { motionScrollBehavior } from '@/lib/motion';

export interface StickyBarProps {
  children: ReactNode;
  className?: string;
  /**
   * Tailwind `top-*` offset. Defaults to `top-10` (40px) so the bar pins
   * directly under the 40px-tall app header (which is `sticky top-0`).
   */
  top?: string;
  /** Render the bottom hairline border. Defaults to true. */
  border?: boolean;
  /**
   * When true, a small "back to top" control fades in at the right edge of the
   * bar WHILE it is pinned (and only then). On a very long dense list the
   * filter strip is often the only fixed landmark once you've scrolled past
   * the page header, so giving it a one-click jump-to-top saves a long manual
   * scroll. The control respects `prefers-reduced-motion` (instant jump). Off
   * by default so existing call sites keep their exact single-child layout.
   */
  backToTop?: boolean;
}

/** Convert a Tailwind `top-N` class to its pixel value (N * 4px). */
function topOffsetPx(top: string): number {
  const m = /(?:^|\s)top-(\d+)(?:\s|$)/.exec(top.trim());
  return m ? Number(m[1]) * 4 : 40;
}

/**
 * A filter / tab strip that pins under the app header when the page scrolls,
 * so the controls stay reachable on long dense lists instead of scrolling off
 * the top.
 *
 * The page itself is the scroll container, so `position: sticky` resolves
 * against the viewport -- no overflow-hidden ancestor is required (and any
 * such ancestor would silently break the stick). A translucent `bg` plus
 * `backdrop-blur` keeps the pinned controls legible over the rows sliding
 * underneath, matching the header's own blur treatment.
 *
 * Stuck-state shadow: CSS alone can't style "position: sticky is currently
 * pinned", so we observe the bar with an IntersectionObserver whose root top
 * is shrunk to the stick line (`top` + 1px). While the bar sits below the line
 * it intersects fully (ratio 1, flat); the instant it pins at the line its top
 * edge clips past the shrunk root (ratio < 1) and we raise a soft bottom
 * shadow to lift the pinned controls off the content scrolling beneath. No
 * sentinel sibling -> the single-div layout (and its `space-y` rhythm) is
 * byte-for-byte unchanged.
 *
 * The same `stuck` signal also drives the optional `backToTop` control, which
 * only appears while pinned (when a jump-to-top is actually useful).
 */
export function StickyBar({
  children,
  className,
  top = 'top-10',
  border = true,
  backToTop = false,
}: StickyBarProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const offset = topOffsetPx(top);
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry) setStuck(entry.intersectionRatio < 1);
      },
      { threshold: [1], rootMargin: `-${offset + 1}px 0px 0px 0px` },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [top]);

  return (
    <div
      ref={ref}
      data-stuck={stuck ? '' : undefined}
      className={`sticky z-20 ${top} bg-bg/80 backdrop-blur transition-shadow supports-[backdrop-filter]:bg-bg/60 ${
        border ? 'border-b border-border-subtle' : ''
      } ${stuck ? 'shadow-[0_6px_16px_-10px_rgba(0,0,0,0.55)]' : ''} ${className ?? ''}`}
    >
      {backToTop ? (
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">{children}</div>
          {stuck ? <BackToTop /> : null}
        </div>
      ) : (
        children
      )}
    </div>
  );
}

/** Small pinned-only jump-to-top control. Honors prefers-reduced-motion. */
function BackToTop() {
  return (
    <button
      type="button"
      onClick={() => window.scrollTo({ top: 0, behavior: motionScrollBehavior() })}
      aria-label="scroll to top"
      className="shrink-0 inline-flex animate-fade-in items-center gap-1 rounded-sm border border-border bg-bg-subtle/80 px-1.5 py-0.5 font-mono text-[10px] lowercase text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg"
    >
      <span aria-hidden>&uarr;</span>
      <span className="hidden sm:inline">top</span>
    </button>
  );
}
