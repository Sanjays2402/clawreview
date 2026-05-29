import { PageHeader } from '@/components/layout/page-header';
import { Card, CardBody, EmptyState, ShieldIcon } from '@clawreview/ui';

export default function Page() {
  return (
    <div className="space-y-6">
      <PageHeader title="Budget" description="Per-installation monthly spend." />
      <Card>
        <CardBody>
          <EmptyState icon={<ShieldIcon size={28} />} title="Nothing here yet" description="Per-installation monthly spend." />
        </CardBody>
      </Card>
    </div>
  );
}
