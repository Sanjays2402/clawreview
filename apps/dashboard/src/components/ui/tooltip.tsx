'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';

const SHOW_DELAY_MS = 250;
const HIDE_DELAY_MS = 75;

type Placement = 'top' | 'bottom';

export interface TooltipProps {
  label: ReactNode;
  placement?: Placement;
  delayMs?: number;
  children: ReactNode;
  className?: string;
}

/**
 * Lightweight, dependency-free tooltip primitive.
 *
 * - Activates on pointer hover AND keyboard focus (a11y).
 * - Press Escape to dismiss while focused (a11y).
 * - Show delay defaults to 250ms (Vercel / Raycast feel), hide delay
 *   short so movement off the trigger feels instant.
 * - Renders inline so it inherits layout context and doesn't need a
 *   portal -- positioned via Tailwind absolute classes relative to the
 *   wrapping span.
 * - For most callers, wrap a single inline-block child (icon button,
 *   pill, glyph). The wrapper is a span so it doesn't break flex/grid.
 */
export function Tooltip({
  label,
  placement = 'top',
  delayMs = SHOW_DELAY_MS,
  children,
  className,
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (showTimer.current) {
      clearTimeout(showTimer.current);
      showTimer.current = null;
    }
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  const show = useCallback(() => {
    clear();
    showTimer.current = setTimeout(() => setOpen(true), delayMs);
  }, [clear, delayMs]);

  const hide = useCallback(() => {
    clear();
    hideTimer.current = setTimeout(() => setOpen(false), HIDE_DELAY_MS);
  }, [clear]);

  useEffect(() => () => clear(), [clear]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape' && open) {
        e.stopPropagation();
        clear();
        setOpen(false);
      }
    },
    [open, clear],
  );

  const positionCls =
    placement === 'top'
      ? 'bottom-full left-1/2 mb-1.5 -translate-x-1/2'
      : 'top-full left-1/2 mt-1.5 -translate-x-1/2';
  const arrowCls =
    placement === 'top'
      ? 'top-full left-1/2 -translate-x-1/2 -translate-y-px border-x-transparent border-b-transparent border-t-border'
      : 'bottom-full left-1/2 -translate-x-1/2 translate-y-px border-x-transparent border-t-transparent border-b-border';

  return (
    <span
      className={`relative inline-flex ${className ?? ''}`}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onKeyDown={onKeyDown}
    >
      <span aria-describedby={open ? id : undefined} className="inline-flex">
        {children}
      </span>
      {open ? (
        <span
          role="tooltip"
          id={id}
          className={`pointer-events-none absolute z-40 whitespace-nowrap rounded-sm border border-border bg-bg px-1.5 py-0.5 font-mono text-[10px] font-medium tracking-wide text-fg shadow-md animate-fade-in ${positionCls}`}
        >
          {label}
          <span aria-hidden className={`absolute h-0 w-0 border-[3px] ${arrowCls}`} />
        </span>
      ) : null}
    </span>
  );
}
