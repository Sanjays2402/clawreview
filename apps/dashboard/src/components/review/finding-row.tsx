'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { ArrowCounterClockwise, X, CaretRight, LinkSimple, Check } from '@phosphor-icons/react';

import { StatusPill } from './status-pill';
import { Tooltip } from '@/components/ui/tooltip';
import type { FindingDto } from '@/lib/data';
import { motionScrollBehavior } from '@/lib/motion';
import { dismissFindingAction, reopenFindingAction } from '@/app/app/reviews/actions';

const SEV_BAR: Record<string, string> = {
  critical: 'bg-severity-critical',
  high: 'bg-severity-high',
  medium: 'bg-severity-medium',
  low: 'bg-severity-low',
  nit: 'bg-severity-nit',
};

const SEV_TEXT: Record<string, string> = {
  critical: 'text-severity-critical',
  high: 'text-severity-high',
  medium: 'text-severity-medium',
  low: 'text-severity-low',
  nit: 'text-severity-nit',
};

export function FindingRow({
  finding,
  reviewId,
  focus = false,
}: {
  finding: FindingDto;
  reviewId: string;
  focus?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [showReason, setShowReason] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [focused, setFocused] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLLIElement | null>(null);

  const dismissed = finding.state === 'dismissed';
  const status = dismissed ? 'dismissed' : 'open';

  // When this row is the deep-link target, scroll it into view + focus it on
  // mount so the operator lands directly on the finding they linked to.
  useEffect(() => {
    if (!focus) return;
    const el = ref.current;
    if (!el) return;
    const t = setTimeout(() => {
      el.scrollIntoView({ block: 'center', behavior: motionScrollBehavior() });
      el.focus();
    }, 80);
    return () => clearTimeout(t);
  }, [focus]);

  function copyLink() {
    const url = `${window.location.origin}/app/reviews/${reviewId}/findings?focus=${encodeURIComponent(finding.id)}`;
    const done = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(done).catch(done);
    } else {
      done();
    }
  }

  function onDismiss(rsn?: string) {
    setError(null);
    startTransition(async () => {
      const res = await dismissFindingAction(finding.id, reviewId, rsn ?? reason);
      if (!res.ok) setError(res.error ?? 'failed');
      else {
        setShowReason(false);
        setReason('');
      }
    });
  }

  function onReopen() {
    setError(null);
    startTransition(async () => {
      const res = await reopenFindingAction(finding.id, reviewId);
      if (!res.ok) setError(res.error ?? 'failed');
    });
  }

  // Per-row keyboard shortcuts when focused: x dismiss, r reopen, e expand
  useEffect(() => {
    if (!focused) return;
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'e') {
        e.preventDefault();
        setExpanded((v) => !v);
      } else if (e.key === 'x' && !dismissed) {
        e.preventDefault();
        onDismiss('');
      } else if (e.key === 'r' && dismissed) {
        e.preventDefault();
        onReopen();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focused, dismissed]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <li
      ref={ref}
      tabIndex={0}
      data-finding-row
      id={`finding-${finding.id}`}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      className={`group relative outline-none ${dismissed ? 'opacity-55' : ''} ${
        focused ? 'bg-accent/[0.06]' : 'hover:bg-bg-subtle/40'
      } ${focus ? 'ring-1 ring-inset ring-accent/50' : ''}`}
    >
      <span className={`sev-strip ${SEV_BAR[finding.severity] ?? 'bg-severity-nit'}`} />
      <div className="flex items-start gap-2 pl-3 pr-2 py-1.5">
        <button
          type="button"
          aria-label={expanded ? 'collapse' : 'expand'}
          onClick={() => setExpanded((v) => !v)}
          className="mt-0.5 shrink-0 text-fg-subtle hover:text-fg"
        >
          <CaretRight size={12} weight="bold" className={expanded ? 'rotate-90 transition-transform' : 'transition-transform'} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
            <span className={`pill-mono border-transparent ${SEV_TEXT[finding.severity] ?? ''}`}>
              {finding.severity}
            </span>
            <span className="mono truncate text-fg">
              {finding.file}
              {finding.line ? <span className="text-fg-subtle">:{finding.line}</span> : null}
            </span>
            <span className={`truncate ${dismissed ? 'line-through decoration-fg-subtle text-fg-muted' : 'text-fg'}`}>
              {finding.title}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-fg-subtle">
            <span className="font-mono">{finding.agent}</span>
            {finding.category ? <span>· {finding.category}</span> : null}
            <span>·</span>
            <StatusPill status={status} />
            <Tooltip label={copied ? 'copied link' : 'copy deep link'}>
              <button
                type="button"
                aria-label="copy deep link to this finding"
                onClick={copyLink}
                className={`inline-flex h-4 w-4 items-center justify-center rounded-sm text-fg-subtle transition-all hover:text-fg ${
                  copied ? 'opacity-100' : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100'
                }`}
              >
                {copied ? (
                  <Check size={11} weight="bold" className="text-emerald-400" />
                ) : (
                  <LinkSimple size={11} weight="bold" />
                )}
              </button>
            </Tooltip>
          </div>

          {expanded ? (
            <div className="mt-2 space-y-2">
              {finding.rationale ? (
                <div className="text-xs text-fg-muted">{finding.rationale}</div>
              ) : null}
              {finding.suggestedPatch ? (
                <pre className="overflow-x-auto rounded-sm border border-border-subtle bg-bg-subtle/60 p-2 font-mono text-[11px] leading-[16px] text-fg">
                  {renderDiff(finding.suggestedPatch)}
                </pre>
              ) : null}
              {dismissed && finding.dismissReason ? (
                <div className="text-[11px] text-fg-subtle">reason: {finding.dismissReason}</div>
              ) : null}

              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                {dismissed ? (
                  <button
                    type="button"
                    onClick={onReopen}
                    disabled={pending}
                    title="reopen (r)"
                    className="inline-flex items-center gap-1 rounded-sm border border-border bg-bg-subtle px-1.5 py-0.5 font-mono text-fg-muted hover:bg-bg-muted disabled:opacity-50"
                  >
                    <ArrowCounterClockwise size={11} weight="bold" />
                    {pending ? 'reopening' : 'reopen'} <kbd className="ml-1 rounded-sm border border-border px-1 text-[9px]">r</kbd>
                  </button>
                ) : showReason ? (
                  <>
                    <input
                      type="text"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="reason (optional)"
                      maxLength={280}
                      className="h-6 w-full max-w-xs rounded-sm border border-border bg-bg px-1.5 font-mono text-[11px] text-fg outline-none focus:border-accent sm:w-64"
                    />
                    <button
                      type="button"
                      onClick={() => onDismiss()}
                      disabled={pending}
                      className="h-6 rounded-sm bg-fg px-2 font-mono text-[11px] text-bg disabled:opacity-50"
                    >
                      {pending ? 'dismissing' : 'confirm'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowReason(false);
                        setReason('');
                      }}
                      className="h-6 rounded-sm border border-border bg-bg-subtle px-2 font-mono text-[11px] text-fg-muted hover:bg-bg-muted"
                    >
                      cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => setShowReason(true)}
                    title="dismiss (x)"
                    className="inline-flex items-center gap-1 rounded-sm border border-border bg-bg-subtle px-1.5 py-0.5 font-mono text-fg-muted hover:bg-bg-muted"
                  >
                    <X size={11} weight="bold" />
                    dismiss <kbd className="ml-1 rounded-sm border border-border px-1 text-[9px]">x</kbd>
                  </button>
                )}
                {error ? <span className="font-mono text-severity-critical">{error}</span> : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function renderDiff(patch: string) {
  const lines = patch.split('\n');
  return (
    <code>
      {lines.map((ln, i) => {
        let cls = 'text-fg-muted';
        if (ln.startsWith('+')) cls = 'text-emerald-400';
        else if (ln.startsWith('-')) cls = 'text-severity-critical';
        else if (ln.startsWith('@@')) cls = 'text-accent';
        return (
          <span key={i} className={`block ${cls}`}>
            {ln || ' '}
          </span>
        );
      })}
    </code>
  );
}
