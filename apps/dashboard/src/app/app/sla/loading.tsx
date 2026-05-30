import { Card, CardBody, CardHeader } from '@clawreview/ui';

import { PageHeader } from '@/components/layout/page-header';

export default function SlaLoading() {
  return (
    <div className="space-y-8">
      <PageHeader title="SLA breaches" description="Open findings whose age exceeds their severity remediation window." />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-20 animate-pulse rounded-lg border border-border-subtle bg-bg-subtle" />
        ))}
      </div>
      <div className="h-32 animate-pulse rounded-lg border border-border-subtle bg-bg-subtle/60" />
      <Card>
        <CardHeader>
          <div className="text-sm font-medium">Breached findings</div>
        </CardHeader>
        <CardBody>
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-8 animate-pulse rounded-md bg-bg-subtle" />
            ))}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
