import { Card, CardBody, CardHeader } from '@clawreview/ui';

import { PageHeader } from '@/components/layout/page-header';
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
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Org-wide defaults pulled live from the server, plus role reference."
      />

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardBody>
            <div className="text-xs uppercase tracking-wide text-fg-subtle">Server</div>
            <div className="mt-2 text-sm font-medium text-fg">
              {version?.name ?? 'clawreview-server'}
            </div>
            <div className="mt-1 text-xs text-fg-muted">
              {version ? `v${version.version}` : 'unreachable'}
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div className="text-xs uppercase tracking-wide text-fg-subtle">Node runtime</div>
            <div className="mt-2 text-sm font-medium text-fg">{version?.node ?? 'unknown'}</div>
            <div className="mt-1 text-xs text-fg-muted">Reported by /version</div>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div className="text-xs uppercase tracking-wide text-fg-subtle">Config source</div>
            <div className="mt-2 text-sm font-medium text-fg">
              {config ? 'GET /api/config/default' : 'unavailable'}
            </div>
            <div className="mt-1 text-xs text-fg-muted">
              {config ? 'Live from server' : 'Server did not respond'}
            </div>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="text-sm font-medium">Roles</div>
        </CardHeader>
        <CardBody>
          <p className="text-sm text-fg-muted">
            Admins can install or remove the GitHub App, change budgets, and rotate signing keys.
            Members can dismiss findings. Viewers can read every page but cannot mutate state.
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <div className="text-sm font-medium">Default .clawreview.yml</div>
        </CardHeader>
        <CardBody>
          {yaml ? (
            <pre className="overflow-x-auto rounded-lg border border-border bg-bg-subtle p-4 text-xs leading-relaxed text-fg">
              {yaml}
            </pre>
          ) : (
            <p className="text-sm text-fg-muted">
              Server is offline, so the live default config could not be loaded. Start the API on
              port 4000 to see the canonical default here.
            </p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
