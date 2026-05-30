import { SeverityBadge } from '@clawreview/ui';

export function SeverityLegend() {
  return (
    <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-fg-muted">
      <span className="uppercase tracking-wider text-fg-subtle">severity</span>
      <SeverityBadge severity="critical" />
      <SeverityBadge severity="high" />
      <SeverityBadge severity="medium" />
      <SeverityBadge severity="low" />
      <SeverityBadge severity="nit" />
    </div>
  );
}
