import { PageHeader } from '@/components/layout/page-header';
import { Card, CardBody } from '@clawreview/ui';

export default function Page() {
  return (
    <div className="space-y-6">
      <PageHeader title="Findings" description="Every finding in this review with filters." />
      <Card><CardBody><div className="text-sm text-fg-muted">Every finding in this review with filters.</div></CardBody></Card>
    </div>
  );
}
