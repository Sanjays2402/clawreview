import { Card, CardBody, CardHeader, EmptyState, ShieldIcon } from '@clawreview/ui';

import { getInstallations } from '@/lib/data';

export default async function InstallationsPage() {
  const items = await getInstallations();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Installations</h1>
        <p className="mt-1 text-sm text-fg-muted">Each row is a GitHub account that installed the ClawReview app.</p>
      </div>

      <Card>
        <CardHeader>
          <div className="text-sm font-medium">Accounts</div>
        </CardHeader>
        <CardBody>
          {items.length === 0 ? (
            <EmptyState
              icon={<ShieldIcon size={28} />}
              title="No installations yet"
              description="Click 'Install on GitHub' on the landing page and pick an org or user to enable reviews on."
            />
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-fg-subtle">
                <tr>
                  <th className="py-2 font-medium">Account</th>
                  <th className="font-medium">Type</th>
                  <th className="font-medium">Repos</th>
                  <th className="font-medium">Spent this month</th>
                  <th className="font-medium">Budget</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {items.map((i) => (
                  <tr key={i.id}>
                    <td className="py-3 font-medium text-fg">{i.login}</td>
                    <td className="text-fg-muted">{i.type}</td>
                    <td className="text-fg-muted">{i.repoCount}</td>
                    <td className="text-fg-muted">${i.spentUsd.toFixed(2)}</td>
                    <td className="text-fg-muted">${i.monthlyBudgetUsd.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
