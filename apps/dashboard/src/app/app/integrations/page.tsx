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

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">Job queue</div>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone(queue?.ok)}`}>
                {queue?.ok ? 'ok' : queue ? 'down' : 'unknown'}
              </span>
            </div>
          </CardHeader>
          <CardBody>
            <dl className="grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-fg-muted">Backend</dt>
              <dd className="text-fg">{queue?.backend ?? 'unknown'}</dd>
              {queue?.error ? (
                <>
                  <dt className="text-fg-muted">Error</dt>
                  <dd className="text-fg">{queue.error}</dd>
                </>
              ) : null}
            </dl>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">Overall readiness</div>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone(ready?.ok)}`}>
                {ready?.ok ? 'ready' : ready ? 'not ready' : 'unreachable'}
              </span>
            </div>
          </CardHeader>
          <CardBody>
            <p className="text-sm text-fg-muted">
              {ready
                ? `Last probed ${new Date(ready.ts).toLocaleString()}.`
                : 'The server did not respond on /readyz. Start the API on port 4000.'}
            </p>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">LLM providers</div>
            <div className="text-xs text-fg-muted">{llm.length} configured</div>
          </div>
        </CardHeader>
        <CardBody>
          {llm.length === 0 ? (
            <EmptyState
              icon={<Plugs size={28} weight="duotone" />}
              title="No providers reachable"
              description="Set LLM_OPENAI_API_KEY, LLM_COPILOT_API_KEY, or point LLM_HERMES_BASE_URL at a local model."
              action={
                <EmptyStateActions
                  primary={{ label: 'configure providers', href: '/docs', external: true }}
                  secondary={{ label: 'view config', href: '/app/config' }}
                />
              }
            />
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-fg-subtle">
                <tr>
                  <th className="py-2 font-medium">Provider</th>
                  <th className="font-medium">Base URL</th>
                  <th className="font-medium">Latency</th>
                  <th className="text-right font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {llm.map((p, i) => (
                  <tr key={`${p.name}-${i}`}>
                    <td className="py-2 font-medium text-fg">{p.name ?? 'unknown'}</td>
                    <td className="font-mono text-[11px] text-fg-muted">{p.baseUrl ?? ''}</td>
                    <td className="text-fg-muted">
                      {typeof p.latencyMs === 'number' ? `${p.latencyMs} ms` : '-'}
                    </td>
                    <td className="text-right">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone(p.ok)}`}>
                        {p.ok ? 'reachable' : 'down'}
                      </span>
                    </td>
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
