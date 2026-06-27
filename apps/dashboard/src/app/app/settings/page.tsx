import { FileCode } from '@phosphor-icons/react/dist/ssr';

import { Card, CardBody, CardHeader, EmptyState } from '@clawreview/ui';

import { PageHeader } from '@/components/layout/page-header';
import { EmptyStateActions } from '@/components/ui/empty-state-actions';
import { getDefaultConfig, getServerVersion } from '@/lib/data';

// Tiny, dependency-free YAML printer that covers the shapes the server
// returns (scalars, arrays of scalars, nested objects). Good enough for
// rendering a default config; not a full YAML serializer.
function toYaml(value: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') {
    return /[:#\-\n"'\[\]\{\}]/.test(value) ? JSON.stringify(value) : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return value
      .map((v) =>
        typeof v === 'object' && v !== null
          ? `${pad}-\n${toYaml(v, indent + 1)}`
          : `${pad}- ${toYaml(v, 0)}`,
      )
      .join('\n');
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    return entries
      .map(([k, v]) => {
        if (v && typeof v === 'object') {
          return `${pad}${k}:\n${toYaml(v, indent + 1)}`;
        }
        return `${pad}${k}: ${toYaml(v, 0)}`;
      })
      .join('\n');
  }
  return String(value);
}

export default async function SettingsPage() {
  const [config, version] = await Promise.all([getDefaultConfig(), getServerVersion()]);
  const yaml = config ? toYaml(config) : null;

  return (
    <div className="space-y-3">
      <PageHeader
        title="settings"
        description="org-wide defaults pulled live from the server, plus role reference."
      />

      <div className="grid gap-3 md:grid-cols-3">
        <MetaCard
          label="server"
          value={version?.name ?? 'clawreview-server'}
          sub={version ? `v${version.version}` : 'unreachable'}
          tone={version ? 'ok' : 'off'}
        />
        <MetaCard
          label="node runtime"
          value={version?.node ?? 'unknown'}
          sub="reported by /version"
          tone={version?.node ? 'ok' : 'off'}
        />
        <MetaCard
          label="config source"
          value={config ? 'GET /api/config/default' : 'unavailable'}
          sub={config ? 'live from server' : 'server did not respond'}
          tone={config ? 'ok' : 'off'}
        />
      </div>

      <Card>
        <CardHeader>
          <div className="font-mono text-[11px] uppercase tracking-wider text-fg-subtle">roles</div>
        </CardHeader>
        <CardBody>
          <dl className="grid gap-2 sm:grid-cols-3">
            {ROLES.map((r) => (
              <div key={r.name} className="rounded-sm border border-border-subtle bg-bg-subtle/30 px-2.5 py-2">
                <dt className="font-mono text-[11px] lowercase text-fg">{r.name}</dt>
                <dd className="mt-1 font-mono text-[11px] leading-relaxed text-fg-muted">{r.can}</dd>
              </div>
            ))}
          </dl>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <div className="font-mono text-[11px] uppercase tracking-wider text-fg-subtle">
            default .clawreview.yml
          </div>
          {yaml ? (
            <span className="font-mono text-[11px] text-fg-subtle">live</span>
          ) : null}
        </CardHeader>
        <CardBody className={yaml ? undefined : 'py-6'}>
          {yaml ? (
            <pre className="overflow-x-auto rounded-sm border border-border-subtle bg-bg-subtle/40 p-3 font-mono text-[11px] leading-relaxed text-fg">
              {yaml}
            </pre>
          ) : (
            <EmptyState
              icon={<FileCode size={20} weight="duotone" />}
              title="default config unavailable"
              description="the server is offline, so the live default .clawreview.yml could not be loaded. start the api on port 4000 to see the canonical default here."
              action={
                <EmptyStateActions
                  primary={{ label: 'open config playground', href: '/app/config' }}
                  secondary={{ label: 'view docs', href: '/docs', external: true }}
                />
              }
            />
          )}
        </CardBody>
      </Card>
    </div>
  );
}

const ROLES: Array<{ name: string; can: string }> = [
  { name: 'admin', can: 'install or remove the github app, change budgets, rotate signing keys.' },
  { name: 'member', can: 'dismiss and reopen findings; cannot change org-wide settings.' },
  { name: 'viewer', can: 'read every page but cannot mutate any state.' },
];

function MetaCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone: 'ok' | 'off';
}) {
  return (
    <Card>
      <CardBody>
        <div className="flex items-center justify-between">
          <span className="font-mono text-[11px] uppercase tracking-wider text-fg-subtle">{label}</span>
          <span
            className={`h-1.5 w-1.5 rounded-full ${tone === 'ok' ? 'bg-emerald-400' : 'bg-fg-subtle/50'}`}
            aria-hidden
          />
        </div>
        <div className="mt-2 truncate font-mono text-xs text-fg" title={value}>
          {value}
        </div>
        <div className="mt-1 font-mono text-[11px] text-fg-muted">{sub}</div>
      </CardBody>
    </Card>
  );
}
