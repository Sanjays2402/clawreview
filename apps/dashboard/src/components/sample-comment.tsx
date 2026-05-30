import { StatusPill } from '@/components/review/status-pill';

const SEV_TEXT: Record<string, string> = {
  critical: 'text-severity-critical',
  high: 'text-severity-high',
  medium: 'text-severity-medium',
  low: 'text-severity-low',
  nit: 'text-severity-nit',
};

const SEV_BAR: Record<string, string> = {
  critical: 'bg-severity-critical',
  high: 'bg-severity-high',
  medium: 'bg-severity-medium',
  low: 'bg-severity-low',
  nit: 'bg-severity-nit',
};

export function SampleComment() {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-bg-subtle/50 font-mono">
      <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-1.5 text-[11px] text-fg-muted">
        <span className="inline-flex h-4 w-4 items-center justify-center rounded-sm bg-accent/20 text-[9px] font-semibold text-accent">CR</span>
        <span className="font-medium text-fg">clawreview</span>
        <span>· bot</span>
        <span className="ml-auto"><StatusPill status="completed" /></span>
      </div>
      <div className="space-y-1 px-3 py-2 text-xs">
        <div className="text-fg-muted">2 high · 3 medium · 1 nit</div>
        <Finding sev="high" file="src/api/users.ts" line={84} title="tainted query reaches prisma raw query" agent="security" />
        <Finding sev="high" file="apps/server/src/auth.ts" line={32} title="token compared with == instead of timing-safe equal" agent="security" />
        <Finding sev="medium" file="src/db/users.ts" line={120} title="n+1 query inside getUsersWithRoles" agent="performance" />
        <div className="border-t border-border-subtle pt-1.5 text-[10px] text-fg-subtle">pr #142 · a1b2c3d</div>
      </div>
    </div>
  );
}

function Finding({
  sev,
  file,
  line,
  title,
  agent,
}: {
  sev: 'critical' | 'high' | 'medium' | 'low' | 'nit';
  file: string;
  line: number;
  title: string;
  agent: string;
}) {
  return (
    <div className="relative pl-2.5">
      <span className={`absolute inset-y-0 left-0 w-[2px] ${SEV_BAR[sev]}`} />
      <div className="flex items-center gap-2 text-[11px]">
        <span className={`uppercase ${SEV_TEXT[sev]}`}>{sev}</span>
        <span className="truncate text-fg">{file}<span className="text-fg-subtle">:{line}</span></span>
        <span className="text-fg-subtle">· {agent}</span>
      </div>
      <div className="text-[12px] text-fg">{title}</div>
    </div>
  );
}
