'use client';

import { useEffect, useState } from 'react';
import { Check } from '@phosphor-icons/react';

/**
 * Toast bus + corner renderer.
 *
 * A single mount point (in the app shell) listens for `cr:toast` window
 * CustomEvents and shows a brief bottom-right confirmation. Decoupling the
 * trigger from the renderer via a window event means a control buried deep in
 * a long scrolled list -- e.g. the per-finding "copy deep link" button -- can
 * confirm its action somewhere always-visible, even if the button itself has
 * scrolled off-screen. (An inline-only check is invisible once you've scrolled
 * away.)
 *
 * Intentionally tiny: no provider, no context, no queue library. Stacks a few
 * recent messages, each self-expiring. Mirrors the global-nav toast's visual
 * language (mono, translucent, backdrop-blur, fade-in) so the chrome stays
 * coherent.
 */

export interface ToastDetail {
  message: string;
  /** Lifetime before auto-dismiss, ms. Default 1800. */
  durationMs?: number;
}

const TOAST_EVENT = 'cr:toast';

/** Fire a toast from anywhere on the client. No-op during SSR. */
export function toast(message: string, durationMs?: number): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<ToastDetail>(TOAST_EVENT, { detail: { message, durationMs } }),
  );
}

interface ActiveToast {
  id: number;
  message: string;
}

export function Toaster() {
  const [toasts, setToasts] = useState<ActiveToast[]>([]);

  useEffect(() => {
    let seq = 0;
    function onToast(e: Event) {
      const detail = (e as CustomEvent<ToastDetail>).detail;
      if (!detail?.message) return;
      const id = ++seq;
      const ttl = detail.durationMs ?? 1800;
      setToasts((cur) => [...cur, { id, message: detail.message }].slice(-3));
      window.setTimeout(() => {
        setToasts((cur) => cur.filter((t) => t.id !== id));
      }, ttl);
    }
    window.addEventListener(TOAST_EVENT, onToast as EventListener);
    return () => window.removeEventListener(TOAST_EVENT, onToast as EventListener);
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col items-end gap-1.5"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-bg/90 px-2.5 py-1.5 font-mono text-[11px] text-fg shadow-lg backdrop-blur animate-fade-in"
        >
          <Check size={12} weight="bold" className="shrink-0 text-emerald-400" />
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  );
}
