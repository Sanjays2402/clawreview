import { Card, CardBody, CardHeader } from '@clawreview/ui';

import {
  AuditTable,
  parseAuditDir,
  parseAuditSort,
} from '@/components/audit/audit-table';
import { PageHeader } from '@/components/layout/page-header';
import { getAudit } from '@/lib/data';

interface PageProps {
  searchParams: Promise<{ action?: string; q?: string; sort?: string; dir?: string }>;
}

export default async function AuditPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const items = await getAudit();
  const sortKey = parseAuditSort(sp.sort);
  const sortDir = parseAuditDir(sp.dir, sortKey === 'when' ? 'desc' : 'asc');
  const action = sp.action?.trim() || 'all';
  const query = sp.q?.trim() || '';

  return (
    <div className="space-y-3">
      <PageHeader title="audit log" description="append-only record of every privileged action." />
      <Card>
        <CardHeader>
          <div className="font-mono text-[11px] uppercase tracking-wider text-fg-subtle">entries</div>
        </CardHeader>
        <CardBody>
          <AuditTable
            entries={items}
            action={action}
            query={query}
            sortKey={sortKey}
            sortDir={sortDir}
          />
        </CardBody>
      </Card>
    </div>
  );
}
