import { PageHeader } from '@/components/layout/page-header';
import { Card, CardBody } from '@clawreview/ui';

export default function Page() {
  return (
    <div className="space-y-6">
      <PageHeader title="Billing" description="Monthly spend and budget controls." />
      <Card><CardBody><div className="text-sm text-fg-muted">Monthly spend and budget controls.</div></CardBody></Card>
    </div>
  );
}
