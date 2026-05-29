import { PageHeader } from '@/components/layout/page-header';
import { Card, CardBody, EmptyState, ShieldIcon } from '@clawreview/ui';

export default function Page() {
  return (
    <div className="space-y-6">
      <PageHeader title="Integrations" description="Slack, Linear, and webhook destinations." />
      <Card>
        <CardBody>
          <EmptyState icon={<ShieldIcon size={28} />} title="Nothing here yet" description="Slack, Linear, and webhook destinations." />
        </CardBody>
      </Card>
    </div>
  );
}
