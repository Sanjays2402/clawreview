import { withRetry } from '@clawreview/llm';

import { AppAuth, type AppCredentials } from './app-auth.js';

export interface PrIdentifier {
  owner: string;
  repo: string;
  number: number;
}

export interface PrSnapshot {
  number: number;
  title: string;
  state: string;
  draft: boolean;
  headSha: string;
  baseSha: string;
  authorLogin: string;
}

export interface PostCommentOptions {
  marker: string;
  body: string;
}

export class GitHubClient {
  private fetchImpl: typeof fetch;

  constructor(
    private readonly token: string,
    fetchImpl: typeof fetch = globalThis.fetch,
  ) {
    this.fetchImpl = fetchImpl;
  }

  static async forInstallation(creds: AppCredentials, installationId: number, fetchImpl?: typeof fetch): Promise<GitHubClient> {
    const auth = new AppAuth(creds, fetchImpl);
    const token = await auth.installationToken(installationId);
    return new GitHubClient(token, fetchImpl);
  }

  async fetchPr(id: PrIdentifier): Promise<PrSnapshot> {
    const json = await this.api<{
      number: number;
      title: string;
      state: string;
      draft: boolean;
      head: { sha: string };
      base: { sha: string };
      user: { login: string };
    }>(`/repos/${id.owner}/${id.repo}/pulls/${id.number}`);
    return {
      number: json.number,
      title: json.title,
      state: json.state,
      draft: json.draft,
      headSha: json.head.sha,
      baseSha: json.base.sha,
      authorLogin: json.user.login,
    };
  }

  async fetchPrDiff(id: PrIdentifier): Promise<string> {
    return this.api<string>(`/repos/${id.owner}/${id.repo}/pulls/${id.number}`, {
      accept: 'application/vnd.github.v3.diff',
      raw: true,
    });
  }

  async fetchRawFile(id: { owner: string; repo: string; path: string; ref: string }): Promise<string | null> {
    try {
      return await this.api<string>(`/repos/${id.owner}/${id.repo}/contents/${encodeURIComponent(id.path)}?ref=${id.ref}`, {
        accept: 'application/vnd.github.raw',
        raw: true,
      });
    } catch (err) {
      if ((err as { status?: number }).status === 404) return null;
      throw err;
    }
  }

  async upsertReviewComment(id: PrIdentifier, opts: PostCommentOptions): Promise<{ id: number }> {
    const comments = await this.api<Array<{ id: number; body: string; user: { login: string; type: string } }>>(
      `/repos/${id.owner}/${id.repo}/issues/${id.number}/comments?per_page=100`,
    );
    const existing = comments.find((c) => c.user.type === 'Bot' && c.body.includes(opts.marker));
    if (existing) {
      const updated = await this.api<{ id: number }>(
        `/repos/${id.owner}/${id.repo}/issues/comments/${existing.id}`,
        { method: 'PATCH', body: { body: opts.body } },
      );
      return { id: updated.id };
    }
    return this.api<{ id: number }>(`/repos/${id.owner}/${id.repo}/issues/${id.number}/comments`, {
      method: 'POST',
      body: { body: opts.body },
    });
  }

  async createCheckRun(id: { owner: string; repo: string }, payload: Record<string, unknown>): Promise<{ id: number }> {
    return this.api<{ id: number }>(`/repos/${id.owner}/${id.repo}/check-runs`, {
      method: 'POST',
      body: payload,
    });
  }

  async api<T>(path: string, opts: { method?: string; body?: unknown; accept?: string; raw?: boolean } = {}): Promise<T> {
    return withRetry(async () => {
      const res = await this.fetchImpl(`https://api.github.com${path}`, {
        method: opts.method ?? 'GET',
        headers: {
          accept: opts.accept ?? 'application/vnd.github+json',
          'content-type': 'application/json',
          authorization: `Bearer ${this.token}`,
          'user-agent': 'clawreview',
          'x-github-api-version': '2022-11-28',
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new Error(`GitHub ${opts.method ?? 'GET'} ${path} failed: ${res.status} ${text.slice(0, 200)}`);
        (err as { status?: number }).status = res.status;
        throw err;
      }
      if (opts.raw) return (await res.text()) as unknown as T;
      return (await res.json()) as T;
    });
  }
}
