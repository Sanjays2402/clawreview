import type { ReactNode } from 'react';

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
 * No negative margins: the strip already spans its container's content width,
 * so rows passing beneath are fully covered; the container's gutter has no
 * content to bleed through.
 */
export function StickyBar({ children, className, top = 'top-10', border = true }: StickyBarProps) {
  return (
    <div
      className={`sticky z-20 ${top} bg-bg/80 backdrop-blur supports-[backdrop-filter]:bg-bg/60 ${
        border ? 'border-b border-border-subtle' : ''
      } ${className ?? ''}`}
    >
      {children}
    </div>
  );
}
