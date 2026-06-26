import { PageHeader } from '@/components/layout/page-header';
import { EmptyStateActions } from '@/components/ui/empty-state-actions';
import { Card, CardBody, EmptyState, ShieldIcon } from '@clawreview/ui';

export default function Page() {
  return (
    <div className="space-y-6">
      <PageHeader title="team" description="org members and roles." />
      <Card>
        <CardBody>
          <EmptyState
            icon={<ShieldIcon size={28} />}
            title="no team members yet"
            description="team roles are managed from your github org. accounts that install the app appear under installations."
            action={
              <EmptyStateActions
                primary={{ label: 'view installations', href: '/app/installations' }}
                secondary={{ label: 'view docs', href: '/docs', external: true }}
              />
            }
          />
        </CardBody>
      </Card>
    </div>
  );
}
