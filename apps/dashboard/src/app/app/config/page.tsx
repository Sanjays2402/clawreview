import { PageHeader } from '@/components/layout/page-header';
import { getDefaultConfig } from '@/lib/data';

import { ConfigValidator } from './config-validator';

// Cheap YAML serializer for a flat-ish JSON object so the editor starts with
// something real even when a stringified template is not available. Falls back
// to a sensible static example if the API is offline.
function toYaml(value: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return value.map((v) => `${pad}- ${toYaml(v, indent + 1).replace(/^\s+/, '')}`).join('\n');
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    return entries
      .map(([k, v]) => {
        const child = toYaml(v, indent + 1);
        if (child.includes('\n') || (Array.isArray(v) && v.length > 0)) {
          return `${pad}${k}:\n${child.startsWith(pad) ? child : `${pad}  ${child}`}`;
        }
        return `${pad}${k}: ${child}`;
      })
      .join('\n');
  }
  return '';
}

const FALLBACK_YAML = `version: 1\nagents:\n  enabled:\n    - security\n    - quality\nbudget:\n  perReviewUsd: 1.50\nseverity:\n  fail: high\n`;

export default async function ConfigPage() {
  const cfg = await getDefaultConfig();
  const seed = cfg ? toYaml(cfg) : FALLBACK_YAML;

  return (
    <div className="space-y-3">
      <PageHeader
        title="config playground"
        description="paste a .clawreview.yml. validate against the live server schema before committing."
      />
      <ConfigValidator defaultYaml={seed} />
    </div>
  );
}
