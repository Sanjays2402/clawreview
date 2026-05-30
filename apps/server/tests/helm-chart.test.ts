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

  it('values.yaml declares serviceMonitor and prometheusRule stanzas', () => {
    const raw = readFileSync(join(helmDir, 'values.yaml'), 'utf8');
    const values = parse(raw) as Record<string, unknown>;

    const sm = values.serviceMonitor as { enabled: boolean; interval: string; path: string };
    expect(sm).toBeDefined();
    expect(typeof sm.enabled).toBe('boolean');
    expect(sm.path).toBe('/metrics');
    expect(sm.interval).toMatch(/^\d+s$/);

    const pr = values.prometheusRule as {
      enabled: boolean;
      thresholds: {
        errorRate: number;
        latencyP95Seconds: number;
        queueDepth: number;
        reviewFailureRate: number;
        llmSpendHourlyUsd: number;
      };
    };
    expect(pr).toBeDefined();
    expect(typeof pr.enabled).toBe('boolean');
    expect(pr.thresholds.errorRate).toBeGreaterThan(0);
    expect(pr.thresholds.errorRate).toBeLessThanOrEqual(1);
    expect(pr.thresholds.latencyP95Seconds).toBeGreaterThan(0);
    expect(pr.thresholds.queueDepth).toBeGreaterThan(0);
    expect(pr.thresholds.reviewFailureRate).toBeGreaterThan(0);
    expect(pr.thresholds.llmSpendHourlyUsd).toBeGreaterThan(0);
  });

  it('servicemonitor.yaml renders a valid ServiceMonitor with /metrics endpoint', () => {
    const stripped = stripHelm(loadTemplate('servicemonitor.yaml'));
    const docs = parseAllDocuments(stripped).map((d) => d.toJS()).filter(Boolean) as Array<Record<string, unknown>>;
    expect(docs.length).toBeGreaterThanOrEqual(1);
    for (const doc of docs) {
      expect(doc.kind).toBe('ServiceMonitor');
      expect(doc.apiVersion).toBe('monitoring.coreos.com/v1');
      const spec = doc.spec as { endpoints: Array<{ port: string; path: string }>; selector: { matchLabels: Record<string, string> } };
      expect(spec.endpoints[0]?.port).toBe('http');
      expect(spec.endpoints[0]?.path).toBe('placeholder'); // placeholder from stripHelm
      expect(spec.selector.matchLabels['app.kubernetes.io/component']).toBe('server');
    }
  });

  it('prometheusrule.yaml renders a PrometheusRule with the expected alerts', () => {
    const raw = loadTemplate('prometheusrule.yaml');
    expect(raw).toMatch(/alert: ClawreviewServerDown/);
    expect(raw).toMatch(/alert: ClawreviewServerHighErrorRate/);
    expect(raw).toMatch(/alert: ClawreviewServerSlowRequests/);
    expect(raw).toMatch(/alert: ClawreviewQueueBacklog/);
    expect(raw).toMatch(/alert: ClawreviewReviewFailureRate/);
    expect(raw).toMatch(/alert: ClawreviewLLMSpendSpike/);
    // Sanity check the queries reference real metrics the server exports.
    expect(raw).toMatch(/http_requests_total/);
    expect(raw).toMatch(/http_request_duration_seconds_bucket/);
    expect(raw).toMatch(/clawreview_queue_depth/);
    expect(raw).toMatch(/clawreview_reviews_completed_total/);
    expect(raw).toMatch(/clawreview_llm_cost_usd_total/);

    // Count rules by scanning the template text directly. The YAML parser
    // cannot fully handle escaped Prometheus templating like
    // `{{ "{{ $labels.foo }}" }}` inside double-quoted annotations, but
    // Helm renders them correctly at install time.
    const ruleCount = (raw.match(/^\s*- alert: /gm) ?? []).length;
    expect(ruleCount).toBeGreaterThanOrEqual(6);

    // Top-level shape still has to parse as a PrometheusRule.
    const head = raw.split('\n').slice(0, 12).join('\n');
    const stripped = stripHelm(head);
    const docs = parseAllDocuments(stripped).map((d) => d.toJS()).filter(Boolean) as Array<Record<string, unknown>>;
    expect(docs.length).toBeGreaterThanOrEqual(1);
    for (const doc of docs) {
      expect(doc.kind).toBe('PrometheusRule');
      expect(doc.apiVersion).toBe('monitoring.coreos.com/v1');
    }
  });

  it('deployment-server uses skipLlm=1 readiness probe so third-party outages do not flap pods', () => {
    const raw = loadTemplate('deployment-server.yaml');
    expect(raw).toMatch(/readinessProbe:[\s\S]*?path:\s*"\/readyz\?skipLlm=1"/);
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
