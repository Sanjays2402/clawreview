import type { Finding, Severity } from '@clawreview/types';

import type { AggregateResult } from './aggregate.js';
import { fingerprint } from './fingerprint.js';

export interface SarifOptions {
  toolName?: string;
  toolVersion?: string;
  informationUri?: string;
  /** Optional commit SHA recorded on each result for traceability. */
  commitSha?: string;
  /** Optional repository root URI baked into versionControlProvenance. */
  repositoryUri?: string;
  /**
   * Optional template producing the `helpUri` for each rule. Receives the
   * rule id (e.g. `security.security`) and finding agent + category and
   * returns a URL string. When omitted, `helpUri` is not emitted.
   *
   * Typical use: link findings back to the dashboard's per-agent docs:
   *   helpUriFor: (id) => `https://docs.clawreview.dev/rules/${id}`
   */
  helpUriFor?: (info: { ruleId: string; agent: string; category: string }) => string;
  /**
   * Findings that were suppressed (e.g. by inline markers or .clawreviewignore).
   * Emitted as a separate SARIF `suppressions[]` array on each result, keeping
   * the audit trail visible while still letting consumers respect the
   * suppression. Pass the same Finding objects that the suppressor returned.
   */
  suppressions?: ReadonlyArray<{ finding: Finding; kind?: SarifSuppressionKind; justification?: string }>;
}

export type SarifSuppressionKind = 'inSource' | 'external';

const DEFAULT_TOOL_NAME = 'clawreview';
const DEFAULT_TOOL_VERSION = '0.1.0';
const DEFAULT_INFORMATION_URI = 'https://github.com/Sanjays2402/clawreview';

/**
 * Render an AggregateResult (or a bare findings array) into SARIF v2.1.0.
 *
 * GitHub code-scanning, Azure DevOps, and most static-analysis dashboards
 * accept this shape directly, so this is the canonical export format used
 * by both the `clawreview run --format sarif` CLI path and the server's
 * GET /api/reviews/:id/sarif endpoint. Keeping a single implementation
 * here means the two paths can't drift.
 */
export function toSarif(
  input: AggregateResult | Finding[],
  opts: SarifOptions = {},
): SarifLog {
  const findings = Array.isArray(input) ? input : input.findings;
  const toolName = opts.toolName ?? DEFAULT_TOOL_NAME;
  const toolVersion = opts.toolVersion ?? DEFAULT_TOOL_VERSION;
  const informationUri = opts.informationUri ?? DEFAULT_INFORMATION_URI;

  const rules = buildRules(findings, opts);
  const ruleIndex = new Map(rules.map((r, i) => [r.id, i]));
  const suppressionByFp = indexSuppressionsByFingerprint(opts.suppressions ?? []);

  const results: SarifResult[] = findings.map((f) => {
    const ruleId = ruleIdFor(f);
    const fp = fingerprint(f);
    const r: SarifResult = {
      ruleId,
      ruleIndex: ruleIndex.get(ruleId) ?? -1,
      level: levelFor(f.severity),
      message: { text: messageText(f) },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: f.file },
            region: {
              startLine: f.startLine,
              endLine: f.endLine ?? f.startLine,
            },
          },
        },
      ],
      // partialFingerprints lets code-scanning UIs collapse the same finding
      // across re-runs/force-pushes; we use the same content fingerprint
      // the aggregator uses for baseline diffing so the two views agree.
      partialFingerprints: {
        clawreviewFingerprint: fp,
        // GitHub's "primaryLocationLineHash" key, with our stable fingerprint
        // value, is the most widely recognised cross-tool key.
        primaryLocationLineHash: fp,
      },
      properties: {
        severity: f.severity,
        confidence: f.confidence,
        agent: f.agent,
        category: f.category,
        ...(f.tags && f.tags.length > 0 ? { tags: f.tags } : {}),
        ...(f.cwe ? { cwe: f.cwe } : {}),
      },
    };
    if (f.suggested) {
      r.fixes = [
        {
          description: { text: f.suggested.description },
          artifactChanges: [
            {
              artifactLocation: { uri: f.file },
              replacements: [
                {
                  deletedRegion: {
                    startLine: f.startLine,
                    endLine: f.endLine ?? f.startLine,
                  },
                  insertedContent: { text: f.suggested.diff },
                },
              ],
            },
          ],
        },
      ];
    }
    const suppression = suppressionByFp.get(fp);
    if (suppression) {
      r.suppressions = [
        {
          kind: suppression.kind ?? 'inSource',
          ...(suppression.justification ? { justification: suppression.justification } : {}),
        },
      ];
    }
    return r;
  });

  const run: SarifRun = {
    tool: {
      driver: {
        name: toolName,
        version: toolVersion,
        informationUri,
        rules,
      },
    },
    results,
  };

  if (opts.commitSha || opts.repositoryUri) {
    run.versionControlProvenance = [
      {
        ...(opts.repositoryUri ? { repositoryUri: opts.repositoryUri } : {}),
        ...(opts.commitSha ? { revisionId: opts.commitSha } : {}),
      },
    ];
  }

  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [run],
  };
}

function ruleIdFor(f: Finding): string {
  return `${f.agent}.${f.category}`;
}

function messageText(f: Finding): string {
  return f.cwe ? `${f.title}\n${f.rationale}\nReference: ${f.cwe}` : `${f.title}\n${f.rationale}`;
}

function buildRules(findings: Finding[], opts: SarifOptions): SarifRule[] {
  const seen = new Map<string, SarifRule>();
  for (const f of findings) {
    const id = ruleIdFor(f);
    if (seen.has(id)) continue;
    const rule: SarifRule = {
      id,
      name: id,
      shortDescription: { text: `${f.category} finding from ${f.agent}` },
      defaultConfiguration: { level: levelFor(f.severity) },
      properties: {
        category: f.category,
        agent: f.agent,
        ...(f.cwe ? { cwe: f.cwe } : {}),
      },
    };
    if (opts.helpUriFor) {
      try {
        const uri = opts.helpUriFor({ ruleId: id, agent: f.agent, category: f.category });
        if (uri) rule.helpUri = uri;
      } catch {
        // helpUriFor is best-effort. Never let it block SARIF emission.
      }
    }
    seen.set(id, rule);
  }
  return [...seen.values()];
}

function indexSuppressionsByFingerprint(
  list: ReadonlyArray<{ finding: Finding; kind?: SarifSuppressionKind; justification?: string }>,
): Map<string, { kind?: SarifSuppressionKind; justification?: string }> {
  const map = new Map<string, { kind?: SarifSuppressionKind; justification?: string }>();
  for (const s of list) {
    map.set(fingerprint(s.finding), { kind: s.kind, justification: s.justification });
  }
  return map;
}

export function levelFor(severity: Severity): 'error' | 'warning' | 'note' {
  if (severity === 'critical' || severity === 'high') return 'error';
  if (severity === 'medium' || severity === 'low') return 'warning';
  return 'note';
}

// Minimal SARIF v2.1.0 surface we emit. Keeping a local definition avoids a
// runtime dep on a SARIF schema package and lets the tests assert the exact
// shape we produce.
export interface SarifLog {
  $schema: string;
  version: '2.1.0';
  runs: SarifRun[];
}

export interface SarifRun {
  tool: { driver: SarifDriver };
  results: SarifResult[];
  versionControlProvenance?: Array<{ repositoryUri?: string; revisionId?: string }>;
}

export interface SarifDriver {
  name: string;
  version: string;
  informationUri: string;
  rules: SarifRule[];
}

export interface SarifRule {
  id: string;
  name: string;
  shortDescription: { text: string };
  defaultConfiguration: { level: 'error' | 'warning' | 'note' };
  helpUri?: string;
  properties?: Record<string, unknown>;
}

export interface SarifResult {
  ruleId: string;
  ruleIndex: number;
  level: 'error' | 'warning' | 'note';
  message: { text: string };
  locations: Array<{
    physicalLocation: {
      artifactLocation: { uri: string };
      region: { startLine: number; endLine: number };
    };
  }>;
  partialFingerprints?: Record<string, string>;
  properties?: Record<string, unknown>;
  suppressions?: Array<{ kind: SarifSuppressionKind; justification?: string }>;
  fixes?: Array<{
    description: { text: string };
    artifactChanges: Array<{
      artifactLocation: { uri: string };
      replacements: Array<{
        deletedRegion: { startLine: number; endLine: number };
        insertedContent: { text: string };
      }>;
    }>;
  }>;
}
