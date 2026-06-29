'use client';

import { useEffect, useRef, useState } from 'react';
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
 *
 * Undo affordance: a destructive-feeling action (a single-finding dismiss) can
 * attach an `action` -- an "undo" button rendered inline. An actionable toast
 * is NEVER deduped (each undo targets a different finding, so collapsing them
 * would point undo at the wrong one) and gets a longer default lifetime so
 * there's time to actually reach for it. The CustomEvent detail carries the
 * callback by reference (same realm, no serialization), so the button just
 * invokes it and dismisses itself.
 *
 * Keyboard UX: the rest of the dashboard is keyboard-driven (j/k list nav, x/r
 * triage, cmd-k palette), so the toast corner answers to the keyboard too. A
 * global `u` fires the NEWEST live actionable toast and dismisses it; pressing
 * `u` again then walks back to the next-newest, so two quick dismisses are two
 * `u`s to fully undo -- no toast is keyboard-unreachable just because another
 * stacked on top. `Escape` clears the corner. Both are ignored while typing in
 * an input/textarea/contenteditable so they never eat real input.
 */

export type ToastTone = 'success' | 'info' | 'neutral' | 'error';

export interface ToastAction {
  /** Short verb shown on the inline button, e.g. "undo". */
  label: string;
  /** Invoked on click. The toast dismisses itself afterward. */
  onClick: () => void;
}

export interface ToastOptions {
  /** Action-scoped glyph + accent. Default 'success'. */
  tone?: ToastTone;
  /** Lifetime before auto-dismiss, ms. Default 1800 (5000 when an action is set). */
  durationMs?: number;
  /** Optional inline action button (e.g. undo). Disables dedupe for this toast. */
  action?: ToastAction;
}

export interface ToastDetail {
  message: string;
  tone: ToastTone;
  durationMs?: number;
  action?: ToastAction;
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
        action: normalized.action,
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
  /** Optional inline action; when present the toast is never deduped. */
  action?: ToastAction;
}

export function Toaster() {
  const [toasts, setToasts] = useState<ActiveToast[]>([]);

  useEffect(() => {
    let seq = 0;
    function onToast(e: Event) {
      const detail = (e as CustomEvent<ToastDetail>).detail;
      if (!detail?.message) return;
      const token = ++seq;
      // An actionable toast lingers longer so there's time to reach the button.
      const ttl = detail.durationMs ?? (detail.action ? 5000 : 1800);
      const tone = detail.tone ?? 'success';
      setToasts((cur) => {
        const last = cur[cur.length - 1];
        // Collapse a repeat of the most-recent message: bump its count and
        // re-token it (refreshing the lifetime) instead of stacking a clone.
        // A tone change on the same message also re-tones the live toast.
        // BUT never collapse an actionable toast (or onto one): each carries a
        // distinct callback, so merging would point undo at the wrong target.
        if (last && last.message === detail.message && !last.action && !detail.action) {
          const merged: ActiveToast = { ...last, count: last.count + 1, token, tone };
          return [...cur.slice(0, -1), merged];
        }
        return [
          ...cur,
          { key: token, message: detail.message, tone, count: 1, token, action: detail.action },
        ].slice(-3);
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

  // Keyboard handling for the corner. Registered once; reads live state via a
  // ref so the handler never goes stale. `u` fires the most-recent actionable
  // toast's action (undo) and removes it; `Escape` clears the whole corner.
  // Skipped while the user is typing so we don't swallow a literal "u".
  const toastsRef = useRef<ActiveToast[]>(toasts);
  toastsRef.current = toasts;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const cur = toastsRef.current;
      if (cur.length === 0) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        setToasts([]);
        return;
      }
      if (e.key === 'u') {
        // Fire the NEWEST actionable toast (the one most likely just triggered)
        // and dismiss it. Because each press removes its target, pressing `u`
        // again walks back to the next-newest -- two stacked dismisses undo
        // with two `u`s. No-op if nothing is undoable.
        const target = [...cur].reverse().find((x) => x.action);
        if (!target) return;
        e.preventDefault();
        target.action?.onClick();
        setToasts((list) => list.filter((x) => x.token !== target.token));
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (toasts.length === 0) return null;

  // The newest actionable toast is the one `u` targets first; any older
  // actionable toasts are reached by pressing `u` again. Mark all but the
  // newest with a quieter "u again" badge so the walk-back order is visible
  // rather than implied -- two stacked dismisses read as a 2-deep undo stack.
  const lastUndoableToken = [...toasts].reverse().find((t) => t.action)?.token ?? null;

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col items-end gap-1.5"
    >
      {toasts.map((t) => {
        const tone = TONE[t.tone] ?? TONE.success;
        const Glyph = tone.icon;
        const isNextUndo = t.action != null && t.token === lastUndoableToken;
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
            {t.action ? (
              <button
                type="button"
                onClick={() => {
                  t.action?.onClick();
                  // Dismiss this toast immediately once the action fires.
                  setToasts((cur) => cur.filter((x) => x.token !== t.token));
                }}
                className="pointer-events-auto ml-0.5 inline-flex shrink-0 items-center gap-1 rounded-sm border border-border bg-bg-subtle px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-fg-muted transition-colors hover:border-accent/60 hover:bg-accent/10 hover:text-fg"
              >
                {t.action.label}
                <kbd
                  className={`rounded-sm border border-border px-1 text-[9px] normal-case tracking-normal ${
                    isNextUndo ? 'text-fg-subtle' : 'text-fg-subtle/40'
                  }`}
                  title={isNextUndo ? 'press u to undo' : 'press u twice to reach this'}
                >
                  u
                </kbd>
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
