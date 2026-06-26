import { PageHeader } from '@/components/layout/page-header';
import { EmptyStateActions } from '@/components/ui/empty-state-actions';
import { Card, CardBody, EmptyState, ShieldIcon } from '@clawreview/ui';

export default function Page() {
  return (
    <div className="space-y-6">
      <PageHeader title="api keys" description="personal tokens for the rest api." />
      <Card>
        <CardBody>
          <EmptyState
            icon={<ShieldIcon size={28} />}
            title="no api keys yet"
            description="personal access tokens for the rest api are coming soon. until then, authenticate with your github app installation token."
            action={
              <EmptyStateActions
                primary={{ label: 'read api docs', href: '/docs', external: true }}
                secondary={{ label: 'view installations', href: '/app/installations' }}
              />
            }
          />
        </CardBody>
      </Card>
    </div>
  );
}
