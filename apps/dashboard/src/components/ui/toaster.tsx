'use client';

import { useEffect, useState } from 'react';
import { Check, Info, Circle, WarningCircle } from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';

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
 *
 * Action-scoped tone: a confirmation reads faster when its glyph + accent
 * match the kind of action. A `success` (resume / reopen / saved) shows the
 * familiar emerald check; an `info` (copy / queued) shows an accent info dot;
 * a `neutral` (dismiss / pause -- a deactivation) shows a quiet filled bullet;
 * an `error` shows a critical warning. Tone defaults to `success` so existing
 * callers are unchanged.
 *
 * Stack-aware dedupe: a fast triage pass (x/r/x/r...) fires the SAME message
 * repeatedly. Rather than show three identical "finding dismissed" toasts that
 * crowd the corner and read as noise, consecutive identical messages collapse
 * into a single toast with a `xN` counter, and each repeat refreshes the
 * lifetime so the running tally stays on-screen while you keep working. Only
 * the MOST RECENT toast dedupes -- an interleaved different message starts a
 * fresh entry, so "dismissed / reopened / dismissed" stays legible as three.
 */

export type ToastTone = 'success' | 'info' | 'neutral' | 'error';

export interface ToastOptions {
  /** Action-scoped glyph + accent. Default 'success'. */
  tone?: ToastTone;
  /** Lifetime before auto-dismiss, ms. Default 1800. */
  durationMs?: number;
}

export interface ToastDetail {
  message: string;
  tone: ToastTone;
  durationMs?: number;
}

const TOAST_EVENT = 'cr:toast';

/**
 * Fire a toast from anywhere on the client. No-op during SSR. The second
 * argument accepts either a bare duration (legacy) or an options object so a
 * caller can pick a tone: `toast('paused', { tone: 'neutral' })`.
 */
export function toast(message: string, opts?: number | ToastOptions): void {
  if (typeof window === 'undefined') return;
  const normalized: ToastOptions = typeof opts === 'number' ? { durationMs: opts } : opts ?? {};
  window.dispatchEvent(
    new CustomEvent<ToastDetail>(TOAST_EVENT, {
      detail: {
        message,
        tone: normalized.tone ?? 'success',
        durationMs: normalized.durationMs,
      },
    }),
  );
}

interface ToneStyle {
  icon: Icon;
  /** Icon color class. */
  cls: string;
  /** Whether the glyph renders as a small filled bullet (neutral). */
  fill?: boolean;
}

const TONE: Record<ToastTone, ToneStyle> = {
  success: { icon: Check, cls: 'text-emerald-400' },
  info: { icon: Info, cls: 'text-accent' },
  neutral: { icon: Circle, cls: 'text-fg-subtle', fill: true },
  error: { icon: WarningCircle, cls: 'text-severity-critical' },
};

interface ActiveToast {
  /** Stable identity for React's key -- preserved across dedupe bumps so the
   *  collapsed toast updates in place (no remount/flash) when its count ticks. */
  key: number;
  message: string;
  tone: ToastTone;
  count: number;
  /** Latest expiry token. Each repeat mints a fresh token so the previous
   *  removal timer becomes a harmless no-op (its token no longer matches). */
  token: number;
}

export function Toaster() {
  const [toasts, setToasts] = useState<ActiveToast[]>([]);

  useEffect(() => {
    let seq = 0;
    function onToast(e: Event) {
      const detail = (e as CustomEvent<ToastDetail>).detail;
      if (!detail?.message) return;
      const token = ++seq;
      const ttl = detail.durationMs ?? 1800;
      const tone = detail.tone ?? 'success';
      setToasts((cur) => {
        const last = cur[cur.length - 1];
        // Collapse a repeat of the most-recent message: bump its count and
        // re-token it (refreshing the lifetime) instead of stacking a clone.
        // A tone change on the same message also re-tones the live toast.
        if (last && last.message === detail.message) {
          const merged: ActiveToast = { ...last, count: last.count + 1, token, tone };
          return [...cur.slice(0, -1), merged];
        }
        return [...cur, { key: token, message: detail.message, tone, count: 1, token }].slice(-3);
      });
      window.setTimeout(() => {
        // Only removes the toast still carrying THIS token. A toast that was
        // bumped after this timer was scheduled now holds a newer token, so
        // this fires as a no-op and its own (later) timer owns the removal.
        setToasts((cur) => cur.filter((t) => t.token !== token));
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
      {toasts.map((t) => {
        const tone = TONE[t.tone] ?? TONE.success;
        const Glyph = tone.icon;
        return (
          <div
            key={t.key}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-bg/90 px-2.5 py-1.5 font-mono text-[11px] text-fg shadow-lg backdrop-blur animate-fade-in"
          >
            <Glyph
              size={tone.fill ? 9 : 12}
              weight={tone.fill ? 'fill' : 'bold'}
              className={`shrink-0 ${tone.cls}`}
            />
            <span>{t.message}</span>
            {t.count > 1 ? (
              <span
                className="shrink-0 rounded-sm bg-bg-muted px-1 text-[10px] tabular-nums text-fg-muted"
                aria-label={`${t.count} times`}
              >
                &times;{t.count}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
