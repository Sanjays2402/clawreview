import { PageHeader } from '@/components/layout/page-header';
import { Card, CardBody } from '@clawreview/ui';

export default function Page() {
  return (
    <div className="space-y-6">
      <PageHeader title="Installation settings" description="Per-installation defaults." />
      <Card><CardBody><div className="text-sm text-fg-muted">Per-installation defaults.</div></CardBody></Card>
    </div>
  );
}
