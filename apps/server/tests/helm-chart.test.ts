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

  it('values.yaml declares a backup stanza with S3 settings and safety guards', () => {
    const raw = readFileSync(join(helmDir, 'values.yaml'), 'utf8');
    const values = parse(raw) as Record<string, unknown>;
    const backup = values.backup as {
      enabled: boolean;
      schedule: string;
      timeZone: string;
      successfulJobsHistoryLimit: number;
      failedJobsHistoryLimit: number;
      startingDeadlineSeconds: number;
      backoffLimit: number;
      activeDeadlineSeconds: number;
      ttlSecondsAfterFinished: number;
      minDumpBytes: number;
      image: { repository: string; tag: string; pullPolicy: string };
      resources: { requests: Record<string, string>; limits: Record<string, string> };
      s3: {
        bucket: string;
        prefix: string;
        region: string;
        endpoint: string;
        storageClass: string;
        accessKeyId: string;
        secretAccessKey: string;
      };
    };
    expect(backup).toBeDefined();
    // Disabled by default so the chart installs without S3 credentials.
    expect(backup.enabled).toBe(false);
    // 5-field cron (m h dom mon dow). Reject 6-field quartz syntax which
    // kubernetes CronJob does not accept.
    expect(backup.schedule.trim().split(/\s+/)).toHaveLength(5);
    expect(backup.timeZone).toBe('Etc/UTC');
    expect(backup.successfulJobsHistoryLimit).toBeGreaterThanOrEqual(1);
    expect(backup.failedJobsHistoryLimit).toBeGreaterThanOrEqual(1);
    expect(backup.startingDeadlineSeconds).toBeGreaterThan(0);
    expect(backup.backoffLimit).toBeGreaterThanOrEqual(0);
    expect(backup.activeDeadlineSeconds).toBeGreaterThan(0);
    expect(backup.ttlSecondsAfterFinished).toBeGreaterThan(0);
    // Guard against silent pg_dump failures that produce tiny dumps.
    expect(backup.minDumpBytes).toBeGreaterThanOrEqual(1024);
    expect(backup.image.repository).toBeTruthy();
    expect(backup.image.tag).toBeTruthy();
    expect(backup.resources.requests.memory).toBeTruthy();
    expect(backup.resources.limits.memory).toBeTruthy();
    expect(backup.s3.prefix).toBeTruthy();
    expect(backup.s3.region).toBeTruthy();
    expect(backup.s3.storageClass).toBeTruthy();
  });

  it('cronjob-backup.yaml gates the whole template on backup.enabled', () => {
    const raw = loadTemplate('cronjob-backup.yaml');
    // First non-empty, non-comment line must be the gate so disabled
    // installs render nothing at all.
    const firstDirective = raw.split('\n').find((l) => l.trim() && !l.trim().startsWith('#'));
    expect(firstDirective).toMatch(/^\{\{-?\s*if\s+\.Values\.backup\.enabled\s*\}\}$/);
    expect(raw.trim().endsWith('{{- end }}')).toBe(true);
  });

  it('cronjob-backup.yaml renders the expected CronJob, ServiceAccount, and Secret', () => {
    const stripped = stripHelm(loadTemplate('cronjob-backup.yaml'));
    const docs = parseAllDocuments(stripped)
      .map((d) => d.toJS())
      .filter(Boolean) as Array<Record<string, unknown>>;
    const kinds = docs.map((d) => d.kind);
    expect(kinds).toContain('CronJob');
    expect(kinds).toContain('ServiceAccount');
    expect(kinds).toContain('Secret');

    const cron = docs.find((d) => d.kind === 'CronJob') as Record<string, any>;
    expect(cron.apiVersion).toBe('batch/v1');
    // Forbid keeps slow runs from stacking and saturating the connection
    // pool against Postgres.
    expect(cron.spec.concurrencyPolicy).toBe('Forbid');
    const podSpec = cron.spec.jobTemplate.spec.template.spec;
    expect(podSpec.restartPolicy).toBe('OnFailure');
    expect(podSpec.serviceAccountName).toBeTruthy();
    const container = podSpec.containers[0];
    expect(container.name).toBe('pg-backup');
    expect(container.args[0]).toMatch(/pg_dump/);
    expect(container.args[0]).toMatch(/aws s3 cp/);
    expect(container.args[0]).toMatch(/--single-transaction|--serializable-deferrable/);
    expect(container.args[0]).toMatch(/gzip/);
    // DATABASE_URL must come from the existing app secret, not a literal.
    const dbEnv = (container.env as Array<Record<string, any>>).find((e) => e.name === 'DATABASE_URL');
    expect(dbEnv?.valueFrom?.secretKeyRef?.key).toBe('DATABASE_URL');
    // S3 credentials live in a dedicated backup secret so they can be
    // rotated independently of the app secret.
    const akEnv = (container.env as Array<Record<string, any>>).find((e) => e.name === 'AWS_ACCESS_KEY_ID');
    expect(akEnv?.valueFrom?.secretKeyRef?.key).toBe('AWS_ACCESS_KEY_ID');
  });
});
