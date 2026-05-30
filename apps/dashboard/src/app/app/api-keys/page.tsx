import { PageHeader } from '@/components/layout/page-header';
import { Card, CardBody, EmptyState, ShieldIcon } from '@clawreview/ui';

export default function Page() {
  return (
    <div className="space-y-6">
      <PageHeader title="api keys" description="personal tokens for the rest api." />
      <Card>
        <CardBody>
          <EmptyState icon={<ShieldIcon size={28} />} title="Nothing here yet" description="Personal tokens for the REST API." />
        </CardBody>
      </Card>
    </div>
  );
}
