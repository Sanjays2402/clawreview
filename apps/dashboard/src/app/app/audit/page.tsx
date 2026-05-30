import { Card, CardBody, CardHeader } from '@clawreview/ui';

import { AuditTable } from '@/components/audit/audit-table';
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
          <AuditTable entries={items} />
        </CardBody>
      </Card>
    </div>
  );
}
