import { Card, CardBody, CardHeader, EmptyState, LockIcon } from '@clawreview/ui';

import { getAudit } from '@/lib/data';

export default async function AuditPage() {
  const items = await getAudit();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
        <p className="mt-1 text-sm text-fg-muted">Append-only record of every privileged action.</p>
      </div>
      <Card>
        <CardHeader>
          <div className="text-sm font-medium">Entries</div>
        </CardHeader>
        <CardBody>
          {items.length === 0 ? (
            <EmptyState
              icon={<LockIcon size={28} />}
              title="No entries yet"
              description="Sign in events, dismissals, and config changes will land here."
            />
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-fg-subtle">
                <tr>
                  <th className="py-2 font-medium">When</th>
                  <th className="font-medium">Actor</th>
                  <th className="font-medium">Action</th>
                  <th className="font-medium">Subject</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {items.map((e) => (
                  <tr key={e.id}>
                    <td className="py-2 text-fg-muted">{new Date(e.createdAt).toLocaleString()}</td>
                    <td className="font-medium text-fg">{e.actorLogin}</td>
                    <td className="text-fg-muted">{e.action}</td>
                    <td className="text-fg-muted">{e.subject ?? '-'}</td>
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
