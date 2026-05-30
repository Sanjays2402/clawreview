import { describe, expect, it } from 'vitest';

import { GitHubClient } from '../src/client.js';

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; method: string; init: RequestInit }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, method: String(init?.method ?? 'GET'), init: init ?? {} });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return { fetch: impl, calls };
}

describe('GitHubClient.createCheckRun', () => {
  it('POSTs to the check-runs endpoint with the given payload', async () => {
    const { fetch, calls } = mockFetch(async () =>
      new Response(JSON.stringify({ id: 7777 }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const gh = new GitHubClient('tok', fetch);
    const res = await gh.createCheckRun(
      { owner: 'o', repo: 'r' },
      {
        name: 'ClawReview',
        head_sha: 'sha1',
        status: 'in_progress',
        started_at: '2026-01-01T00:00:00.000Z',
      },
    );
    expect(res.id).toBe(7777);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toContain('/repos/o/r/check-runs');
    const sent = JSON.parse(calls[0]!.init.body as string);
    expect(sent.status).toBe('in_progress');
    expect(sent.head_sha).toBe('sha1');
  });
});

describe('GitHubClient.updateCheckRun', () => {
  it('PATCHes the check-run by id and forwards the payload', async () => {
    const { fetch, calls } = mockFetch(async () =>
      new Response(JSON.stringify({ id: 7777 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const gh = new GitHubClient('tok', fetch);
    const res = await gh.updateCheckRun(
      { owner: 'o', repo: 'r', checkRunId: 7777 },
      {
        status: 'completed',
        conclusion: 'neutral',
        completed_at: '2026-01-01T00:01:00.000Z',
        output: { title: 'Done', summary: '0 findings' },
      },
    );
    expect(res.id).toBe(7777);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.url).toContain('/repos/o/r/check-runs/7777');
    const sent = JSON.parse(calls[0]!.init.body as string);
    expect(sent.status).toBe('completed');
    expect(sent.conclusion).toBe('neutral');
    expect(sent.output.summary).toBe('0 findings');
  });

  it('surfaces non-2xx responses as errors', async () => {
    const { fetch } = mockFetch(async () =>
      new Response(JSON.stringify({ message: 'Not Found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const gh = new GitHubClient('tok', fetch);
    await expect(
      gh.updateCheckRun({ owner: 'o', repo: 'r', checkRunId: 1 }, { status: 'completed' }),
    ).rejects.toThrow();
  });
});
