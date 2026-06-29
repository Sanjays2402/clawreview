import { Card, CardBody, CardHeader } from '@clawreview/ui';

import { PageHeader } from '@/components/layout/page-header';

export default function TrendsLoading() {
  return (
    <div className="space-y-4">
      <PageHeader title="trends" description="aggregate review and finding volume over a custom window." />
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-20 animate-pulse rounded-lg border border-border-subtle bg-bg-subtle" />
        ))}
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="font-mono text-[11px] uppercase tracking-wider text-fg-subtle">findings/day</div>
          </CardHeader>
          <CardBody>
            <div className="h-20 animate-pulse rounded-md bg-bg-subtle" />
          </CardBody>
        </Card>
        <Card>
          <CardHeader>
            <div className="font-mono text-[11px] uppercase tracking-wider text-fg-subtle">severity mix</div>
          </CardHeader>
          <CardBody>
            <div className="h-8 animate-pulse rounded-md bg-bg-subtle" />
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
