import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const ciPath = join(__dirname, '..', '..', '..', '.github', 'workflows', 'ci.yml');

interface Step {
  name?: string;
  uses?: string;
  run?: string;
}
interface Job {
  needs?: string | string[];
  steps: Step[];
  strategy?: { matrix?: Record<string, unknown> };
}
interface Workflow {
  name: string;
  on: unknown;
  jobs: Record<string, Job>;
}

function loadCi(): Workflow {
  const raw = readFileSync(ciPath, 'utf8');
  return parse(raw) as Workflow;
}

function jobRuns(job: Job): string[] {
  return job.steps.filter((s) => typeof s.run === 'string').map((s) => s.run as string);
}

function jobUses(job: Job): string[] {
  return job.steps.filter((s) => typeof s.uses === 'string').map((s) => s.uses as string);
}

describe('ci workflow', () => {
  const wf = loadCi();

  it('exposes the four required jobs that gate a release', () => {
    // Tests, a real production build, helm validation, and a docker
    // image build must all be wired into CI so a broken main can never
    // ship a deployable artefact silently.
    expect(Object.keys(wf.jobs).sort()).toEqual(
      ['build', 'docker-build', 'helm-validate', 'lint-typecheck-test'].sort(),
    );
  });

  it('build job actually runs pnpm build and uploads the server dist', () => {
    const build = wf.jobs.build;
    expect(build).toBeDefined();
    expect(build.needs).toBe('lint-typecheck-test');

    const runs = jobRuns(build);
    expect(runs.some((r) => /\bpnpm build\b/.test(r))).toBe(true);
    expect(runs.some((r) => r.includes('apps/server/dist/index.js'))).toBe(true);

    const uses = jobUses(build);
    expect(uses.some((u) => u.startsWith('actions/upload-artifact@'))).toBe(true);
  });

  it('helm-validate job lints, templates, and schema-validates the chart', () => {
    const helm = wf.jobs['helm-validate'];
    expect(helm).toBeDefined();

    const uses = jobUses(helm);
    expect(uses.some((u) => u.startsWith('azure/setup-helm@'))).toBe(true);

    const runs = jobRuns(helm).join('\n');
    expect(runs).toMatch(/helm lint infra\/helm\/clawreview/);
    expect(runs).toMatch(/helm template clawreview infra\/helm\/clawreview/);
    expect(runs).toMatch(/autoscaling\.enabled=true/);
    expect(runs).toMatch(/kubeconform/);
    // Assert at least one of the kinds the gate enforces so a future
    // edit that drops the guard breaks this test.
    expect(runs).toMatch(/HorizontalPodAutoscaler/);
    expect(runs).toMatch(/NetworkPolicy/);
  });

  it('docker-build job builds both server and dashboard images via matrix', () => {
    const docker = wf.jobs['docker-build'];
    expect(docker).toBeDefined();
    expect(docker.needs).toBe('lint-typecheck-test');

    const images = (docker.strategy?.matrix as { image?: Array<{ name: string; dockerfile: string }> } | undefined)?.image;
    expect(images).toBeDefined();
    const names = (images ?? []).map((i) => i.name).sort();
    expect(names).toEqual(['dashboard', 'server']);

    const uses = jobUses(docker);
    expect(uses.some((u) => u.startsWith('docker/setup-buildx-action@'))).toBe(true);
    expect(uses.some((u) => u.startsWith('docker/build-push-action@'))).toBe(true);
  });

  it('all jobs are guarded by the ENABLE_CI repository variable', () => {
    for (const [name, job] of Object.entries(wf.jobs)) {
      const cond = (job as unknown as { if?: string }).if;
      expect(cond, `job ${name} missing if guard`).toBeDefined();
      expect(cond).toContain("vars.ENABLE_CI == 'true'");
    }
  });
});
