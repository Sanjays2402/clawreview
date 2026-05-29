import { SeverityBadge } from '@clawreview/ui';

export function FindingRow({ finding }: { finding: { agent: string; severity: 'critical'|'high'|'medium'|'low'|'nit'; file: string; line: number; title: string; rationale: string } }) {
  return (
    <div className="rounded-lg border border-border bg-bg-subtle/40 p-3">
      <div className="flex items-center gap-2 text-xs">
        <SeverityBadge severity={finding.severity} />
        <span className="font-mono text-fg-muted">{finding.file}:{finding.line}</span>
        <span className="text-fg-subtle">{finding.agent}</span>
      </div>
      <div className="mt-1 font-medium text-fg">{finding.title}</div>
      <div className="mt-1 text-sm text-fg-muted">{finding.rationale}</div>
    </div>
  );
}
