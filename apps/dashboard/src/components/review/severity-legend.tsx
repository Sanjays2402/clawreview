import { SeverityBadge } from '@clawreview/ui';

export function SeverityLegend() {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
      Severities:
      <SeverityBadge severity="critical" />
      <SeverityBadge severity="high" />
      <SeverityBadge severity="medium" />
      <SeverityBadge severity="low" />
      <SeverityBadge severity="nit" />
    </div>
  );
}
