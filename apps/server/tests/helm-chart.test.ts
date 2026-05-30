import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAllDocuments, parse } from 'yaml';

const helmDir = join(__dirname, '..', '..', '..', 'infra', 'helm', 'clawreview');

/**
 * Strip Helm template directives so we can validate the YAML skeleton.
 *
 * - Drops whole-line `{{- if/end/range/with }}` control blocks.
 * - Replaces inline `{{ ... }}` expressions with a stable placeholder so
 *   surrounding YAML structure stays parseable.
 *
 * This is not a full Helm render (no helm binary in CI test env), but it
 * catches indentation regressions and missing `kind:` fields.
 */
function stripHelm(src: string): string {
  const lines = src.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\{\{-?\s*(if|else|end|range|with|define|toYaml|include|\/\*)/.test(trimmed)) continue;
    if (trimmed.startsWith('{{') && trimmed.endsWith('}}')) continue;
    out.push(line.replace(/\{\{[^}]*\}\}/g, 'placeholder'));
  }
  return out.join('\n');
}

function loadTemplate(name: string): string {
  return readFileSync(join(helmDir, 'templates', name), 'utf8');
}

describe('helm chart', () => {
  it('values.yaml declares autoscaling, PDB, and networkPolicy stanzas', () => {
    const raw = readFileSync(join(helmDir, 'values.yaml'), 'utf8');
    const values = parse(raw) as Record<string, unknown>;

    expect(values.autoscaling).toBeDefined();
    const autoscaling = values.autoscaling as Record<string, { enabled: boolean; minReplicas: number; maxReplicas: number }>;
    expect(autoscaling.server.minReplicas).toBeGreaterThanOrEqual(1);
    expect(autoscaling.server.maxReplicas).toBeGreaterThan(autoscaling.server.minReplicas);
    expect(autoscaling.dashboard.maxReplicas).toBeGreaterThan(0);

    expect(values.podDisruptionBudget).toBeDefined();
    const pdb = values.podDisruptionBudget as Record<string, { enabled: boolean; minAvailable?: number }>;
    expect(pdb.server.enabled).toBe(true);
    expect(pdb.dashboard.enabled).toBe(true);

    expect(values.networkPolicy).toBeDefined();
    const np = values.networkPolicy as { enabled: boolean; server: { allowFromNamespaces: string[] } };
    expect(typeof np.enabled).toBe('boolean');
    expect(Array.isArray(np.server.allowFromNamespaces)).toBe(true);
  });

  it('hpa.yaml renders valid YAML with HorizontalPodAutoscaler kinds', () => {
    const stripped = stripHelm(loadTemplate('hpa.yaml'));
    const docs = parseAllDocuments(stripped).map((d) => d.toJS()).filter(Boolean) as Array<Record<string, unknown>>;
    expect(docs.length).toBeGreaterThanOrEqual(2);
    for (const doc of docs) {
      expect(doc.kind).toBe('HorizontalPodAutoscaler');
      expect(doc.apiVersion).toBe('autoscaling/v2');
    }
  });

  it('pdb.yaml renders valid YAML with PodDisruptionBudget kinds', () => {
    const stripped = stripHelm(loadTemplate('pdb.yaml'));
    const docs = parseAllDocuments(stripped).map((d) => d.toJS()).filter(Boolean) as Array<Record<string, unknown>>;
    expect(docs.length).toBeGreaterThanOrEqual(2);
    for (const doc of docs) {
      expect(doc.kind).toBe('PodDisruptionBudget');
      expect(doc.apiVersion).toBe('policy/v1');
    }
  });

  it('networkpolicy.yaml renders valid YAML with NetworkPolicy kinds and dns egress', () => {
    const raw = loadTemplate('networkpolicy.yaml');
    expect(raw).toMatch(/k8s-app: kube-dns/);
    expect(raw).toMatch(/169\.254\.169\.254\/32/); // blocks cloud metadata
    const stripped = stripHelm(raw);
    const docs = parseAllDocuments(stripped).map((d) => d.toJS()).filter(Boolean) as Array<Record<string, unknown>>;
    expect(docs.length).toBeGreaterThanOrEqual(2);
    for (const doc of docs) {
      expect(doc.kind).toBe('NetworkPolicy');
      expect(doc.apiVersion).toBe('networking.k8s.io/v1');
    }
  });
});
