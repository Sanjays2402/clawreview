import { Card, CardBody, CardHeader, EmptyState } from '@clawreview/ui';
import { Plugs } from '@phosphor-icons/react/dist/ssr';

import { PageHeader } from '@/components/layout/page-header';
import { EmptyStateActions } from '@/components/ui/empty-state-actions';
import { getReadiness } from '@/lib/data';

function tone(ok: boolean | undefined): string {
  if (ok === true) return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400';
  if (ok === false) return 'bg-rose-500/10 text-rose-600 dark:text-rose-400';
  return 'bg-fg/10 text-fg-muted';
}

export default async function IntegrationsPage() {
  const ready = await getReadiness();
  const queue = ready?.checks.queue;
  const llm = ready?.checks.llm ?? [];

  return (
    <div className="space-y-3">
      <PageHeader
        title="integrations"
        description="live health for the queue and llm providers wired into this server."
      />

      <div className="grid gap-3 md:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="font-mono text-[11px] uppercase tracking-wider text-fg-subtle">job queue</div>
            <span className={`rounded-sm px-2 py-0.5 font-mono text-[10px] font-medium lowercase ${tone(queue?.ok)}`}>
              {queue?.ok ? 'ok' : queue ? 'down' : 'unknown'}
            </span>
          </CardHeader>
          <CardBody>
            <dl className="grid grid-cols-2 gap-y-2 font-mono text-xs">
              <dt className="text-fg-subtle">backend</dt>
              <dd className="text-fg">{queue?.backend ?? 'unknown'}</dd>
              {queue?.error ? (
                <>
                  <dt className="text-fg-subtle">error</dt>
                  <dd className="text-severity-critical">{queue.error}</dd>
                </>
              ) : null}
            </dl>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="font-mono text-[11px] uppercase tracking-wider text-fg-subtle">overall readiness</div>
            <span className={`rounded-sm px-2 py-0.5 font-mono text-[10px] font-medium lowercase ${tone(ready?.ok)}`}>
              {ready?.ok ? 'ready' : ready ? 'not ready' : 'unreachable'}
            </span>
          </CardHeader>
          <CardBody>
            <p className="font-mono text-xs text-fg-muted">
              {ready
                ? `last probed ${new Date(ready.ts).toLocaleString()}.`
                : 'the server did not respond on /readyz. start the api on port 4000.'}
            </p>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="font-mono text-[11px] uppercase tracking-wider text-fg-subtle">llm providers</div>
          <div className="font-mono text-[11px] tabular-nums text-fg-muted">{llm.length} configured</div>
        </CardHeader>
        <CardBody>
          {llm.length === 0 ? (
            <EmptyState
              icon={<Plugs size={28} weight="duotone" />}
              title="no providers reachable"
              description="set LLM_OPENAI_API_KEY, LLM_COPILOT_API_KEY, or point LLM_HERMES_BASE_URL at a local model."
              action={
                <EmptyStateActions
                  primary={{ label: 'configure providers', href: '/docs', external: true }}
                  secondary={{ label: 'view config', href: '/app/config' }}
                />
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[480px] font-mono text-xs">
                <thead className="text-left text-[10px] uppercase tracking-wider text-fg-subtle">
                  <tr>
                    <th className="py-1.5 font-medium">provider</th>
                    <th className="font-medium">base url</th>
                    <th className="font-medium tabular-nums">latency</th>
                    <th className="text-right font-medium">status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {llm.map((p, i) => (
                    <tr key={`${p.name}-${i}`} className="hover:bg-bg-subtle/40">
                      <td className="py-1.5 text-fg">{p.name ?? 'unknown'}</td>
                      <td className="text-[11px] text-fg-muted">{p.baseUrl ?? ''}</td>
                      <td className="tabular-nums text-fg-muted">
                        {typeof p.latencyMs === 'number' ? `${p.latencyMs} ms` : '-'}
                      </td>
                      <td className="text-right">
                        <span className={`rounded-sm px-2 py-0.5 text-[10px] font-medium lowercase ${tone(p.ok)}`}>
                          {p.ok ? 'reachable' : 'down'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
