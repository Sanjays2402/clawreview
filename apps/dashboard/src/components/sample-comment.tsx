import { SeverityBadge } from '@clawreview/ui';

export function SampleComment() {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-bg-subtle/60 shadow-sm">
      <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-2 text-xs text-fg-muted">
        <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-fg/10 font-semibold text-fg">CR</span>
        <span className="font-medium text-fg">clawreview</span>
        <span>commented on this pull request</span>
      </div>
      <div className="space-y-4 p-5 text-sm">
        <div className="font-semibold">ClawReview</div>
        <div className="text-fg-muted">2 high · 3 medium · 1 nit</div>
        <div className="space-y-3">
          <Finding sev="high" file="src/api/users.ts" line={84} title="Tainted query parameter reaches Prisma raw query" agent="sql-injection" />
          <Finding sev="high" file="apps/server/src/auth.ts" line={32} title="Session token compared with == instead of timing-safe equal" agent="security" />
          <Finding sev="medium" file="src/db/users.ts" line={120} title="N+1 query inside getUsersWithRoles" agent="performance" />
        </div>
        <div className="border-t border-border-subtle pt-3 text-xs text-fg-subtle">
          ClawReview · PR #142 · a1b2c3d
        </div>
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
    <div className="rounded-lg border border-border-subtle bg-bg/60 p-3">
      <div className="flex items-center gap-2">
        <SeverityBadge severity={sev} />
        <span className="font-mono text-xs text-fg-muted">{file}:{line}</span>
        <span className="text-xs text-fg-subtle">· {agent}</span>
      </div>
      <div className="mt-1 text-fg">{title}</div>
    </div>
  );
}
