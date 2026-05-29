import { PageHeader } from '@/components/layout/page-header';
import { Card, CardBody, CardHeader } from '@clawreview/ui';

export default async function RepoDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="space-y-6">
      <PageHeader title={id} description="Per-repo settings, recent reviews, ignored paths." />
      <Card>
        <CardHeader><div className="text-sm font-medium">Recent reviews</div></CardHeader>
        <CardBody><div className="text-sm text-fg-muted">No reviews to show.</div></CardBody>
      </Card>
    </div>
  );
}
