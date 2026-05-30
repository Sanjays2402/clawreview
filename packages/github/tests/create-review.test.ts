import { describe, expect, it } from 'vitest';

import { GitHubClient } from '../src/client.js';

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return { fetch: impl, calls };
}

describe('GitHubClient.createReview', () => {
  it('posts a review with inline comments and reports the count', async () => {
    const { fetch, calls } = mockFetch(async (_url, init) => {
      const body = JSON.parse((init.body as string) ?? '{}');
      return new Response(
        JSON.stringify({ id: 4242, html_url: 'https://github.com/o/r/pull/1#review-4242', comments: body.comments }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const gh = new GitHubClient('tok', fetch);
    const res = await gh.createReview(
      { owner: 'o', repo: 'r', number: 1 },
      {
        commitSha: 'deadbeef',
        body: 'Two inline comments',
        comments: [
          { path: 'src/a.ts', line: 10, body: 'first' },
          { path: 'src/b.ts', line: 22, body: 'second', startLine: 20 },
        ],
      },
    );
    expect(res.id).toBe(4242);
    expect(res.submittedInlineCount).toBe(2);

    expect(calls).toHaveLength(1);
    const sent = JSON.parse(calls[0]!.init.body as string);
    expect(sent.commit_id).toBe('deadbeef');
    expect(sent.event).toBe('COMMENT');
    expect(sent.comments).toHaveLength(2);
    expect(sent.comments[0]).toEqual({ path: 'src/a.ts', line: 10, side: 'RIGHT', body: 'first' });
    expect(sent.comments[1]).toMatchObject({ path: 'src/b.ts', line: 22, side: 'RIGHT', start_line: 20, start_side: 'RIGHT' });
  });

  it('honors a custom review event', async () => {
    const { fetch, calls } = mockFetch(async () =>
      new Response(JSON.stringify({ id: 7 }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const gh = new GitHubClient('tok', fetch);
    await gh.createReview(
      { owner: 'o', repo: 'r', number: 1 },
      { commitSha: 'sha', body: 'block', event: 'REQUEST_CHANGES', comments: [] },
    );
    const sent = JSON.parse(calls[0]!.init.body as string);
    expect(sent.event).toBe('REQUEST_CHANGES');
    expect(sent.comments).toEqual([]);
  });

  it('throws with the GitHub error body on failure', async () => {
    const { fetch } = mockFetch(async () =>
      new Response(JSON.stringify({ message: 'commit_id must be a valid SHA' }), {
        status: 422,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const gh = new GitHubClient('tok', fetch);
    await expect(
      gh.createReview(
        { owner: 'o', repo: 'r', number: 1 },
        { commitSha: 'bad', body: 'x', comments: [{ path: 'a', line: 1, body: 'b' }] },
      ),
    ).rejects.toThrow(/422/);
  });
});
