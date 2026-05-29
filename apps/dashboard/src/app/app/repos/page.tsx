import { PageHeader } from '@/components/layout/page-header';
import { Card, CardBody, EmptyState, ShieldIcon } from '@clawreview/ui';

export default function Page() {
  return (
    <div className="space-y-6">
      <PageHeader title="Repositories" description="Repos across installations." />
      <Card>
        <CardBody>
          <EmptyState icon={<ShieldIcon size={28} />} title="Nothing here yet" description="Repos across installations." />
        </CardBody>
      </Card>
    </div>
  );
}
