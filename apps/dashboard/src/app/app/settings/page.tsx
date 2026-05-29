import { Card, CardBody, CardHeader } from '@clawreview/ui';

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-fg-muted">Org-wide defaults, RBAC, and integrations.</p>
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
          <pre className="overflow-x-auto rounded-lg border border-border bg-bg-subtle p-4 text-xs leading-relaxed text-fg">
{`agents:
  - security
  - performance
  - style
  - secrets
severity_threshold: low
ignore:
  - "**/*.snap"
  - "**/vendor/**"
budget:
  monthly_usd: 50
comment_style: detailed`}
          </pre>
        </CardBody>
      </Card>
    </div>
  );
}
