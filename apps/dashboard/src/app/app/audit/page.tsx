import { Card, CardBody, CardHeader } from '@clawreview/ui';

import { AuditTable } from '@/components/audit/audit-table';
import { PageHeader } from '@/components/layout/page-header';
import { getAudit } from '@/lib/data';

export default async function AuditPage() {
  const items = await getAudit();
  return (
    <div className="space-y-3">
      <PageHeader title="audit log" description="append-only record of every privileged action." />
      <Card>
        <CardHeader>
          <div className="font-mono text-[11px] uppercase tracking-wider text-fg-subtle">entries</div>
        </CardHeader>
        <CardBody>
          <AuditTable entries={items} />
        </CardBody>
      </Card>
    </div>
  );
}
