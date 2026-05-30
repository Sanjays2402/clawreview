import { withRetry } from '@clawreview/llm';

import { buildAppJwt } from './jwt.js';

export interface AppCredentials {
  appId: string | number;
  privateKey: string;
  clientId?: string;
  clientSecret?: string;
}

interface InstallationToken {
  token: string;
  expiresAt: number;
}

const SAFETY_MS = 60_000;

/**
 * Minimal projection of a GitHub App installation as returned by
 * GET /app/installations. Only the fields we expose through the public
 * API surface are typed here so unrelated payload churn from GitHub does
 * not break callers.
 */
export interface InstallationSummary {
  id: number;
  account: { login: string; type: 'User' | 'Organization'; id: number } | null;
  targetType: 'User' | 'Organization';
  repositorySelection: 'all' | 'selected';
  appSlug: string | null;
  suspendedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RepositorySummary {
  id: number;
  nodeId: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string | null;
  archived: boolean;
  disabled: boolean;
  htmlUrl: string;
}

export interface ListReposPage {
  totalCount: number;
  repositories: RepositorySummary[];
}

interface RawInstallation {
  id: number;
  account: { login: string; type: string; id: number } | null;
  target_type: string;
  repository_selection: string;
  app_slug?: string;
  suspended_at: string | null;
  created_at: string;
  updated_at: string;
}

interface RawRepository {
  id: number;
  node_id: string;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string | null;
  archived: boolean;
  disabled: boolean;
  html_url: string;
}

function mapInstallation(raw: RawInstallation): InstallationSummary {
  const targetType = (raw.target_type === 'User' ? 'User' : 'Organization') as 'User' | 'Organization';
  const account = raw.account
    ? {
        login: raw.account.login,
        id: raw.account.id,
        type: (raw.account.type === 'User' ? 'User' : 'Organization') as 'User' | 'Organization',
      }
    : null;
  return {
    id: raw.id,
    account,
    targetType,
    repositorySelection: raw.repository_selection === 'selected' ? 'selected' : 'all',
    appSlug: raw.app_slug ?? null,
    suspendedAt: raw.suspended_at,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

function mapRepository(raw: RawRepository): RepositorySummary {
  return {
    id: raw.id,
    nodeId: raw.node_id,
    name: raw.name,
    fullName: raw.full_name,
    private: raw.private,
    defaultBranch: raw.default_branch,
    archived: raw.archived,
    disabled: raw.disabled,
    htmlUrl: raw.html_url,
  };
}

export class AppAuth {
  private cache = new Map<number, InstallationToken>();
  private fetchImpl: typeof fetch;

  constructor(
    private readonly creds: AppCredentials,
    fetchImpl: typeof fetch = globalThis.fetch,
  ) {
    this.fetchImpl = fetchImpl;
  }

  appJwt(): string {
    return buildAppJwt({ appId: this.creds.appId, privateKey: this.creds.privateKey });
  }

  async installationToken(installationId: number): Promise<string> {
    const cached = this.cache.get(installationId);
    if (cached && cached.expiresAt - SAFETY_MS > Date.now()) {
      return cached.token;
    }
    const token = await withRetry(async () => {
      const res = await this.fetchImpl(
        `https://api.github.com/app/installations/${installationId}/access_tokens`,
        {
          method: 'POST',
          headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${this.appJwt()}`,
            'user-agent': 'clawreview',
            'x-github-api-version': '2022-11-28',
          },
        },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new Error(`installation token failed: ${res.status} ${text.slice(0, 200)}`);
        (err as { status?: number }).status = res.status;
        throw err;
      }
      const json = (await res.json()) as { token: string; expires_at: string };
      return {
        token: json.token,
        expiresAt: Date.parse(json.expires_at),
      } satisfies InstallationToken;
    });
    this.cache.set(installationId, token);
    return token.token;
  }

  /**
   * List every installation of this GitHub App. Paginates through the
   * GitHub-imposed 100-per-page cap and returns the flattened list. Uses
   * the JWT (not an installation token) per GitHub's API contract.
   */
  async listInstallations(opts: { perPage?: number; maxPages?: number } = {}): Promise<InstallationSummary[]> {
    const perPage = Math.min(Math.max(opts.perPage ?? 100, 1), 100);
    const maxPages = Math.max(opts.maxPages ?? 10, 1);
    const out: InstallationSummary[] = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const batch = await withRetry(async () => {
        const res = await this.fetchImpl(
          `https://api.github.com/app/installations?per_page=${perPage}&page=${page}`,
          {
            method: 'GET',
            headers: {
              accept: 'application/vnd.github+json',
              authorization: `Bearer ${this.appJwt()}`,
              'user-agent': 'clawreview',
              'x-github-api-version': '2022-11-28',
            },
          },
        );
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          const err = new Error(`list installations failed: ${res.status} ${text.slice(0, 200)}`);
          (err as { status?: number }).status = res.status;
          throw err;
        }
        return (await res.json()) as RawInstallation[];
      });
      for (const inst of batch) out.push(mapInstallation(inst));
      if (batch.length < perPage) break;
    }
    return out;
  }

  /**
   * List repositories accessible to a specific installation. Authenticates
   * with that installation's short-lived token (cached) rather than the
   * App JWT, matching GitHub's API contract for this endpoint.
   */
  async listInstallationRepositories(
    installationId: number,
    opts: { perPage?: number; page?: number } = {},
  ): Promise<ListReposPage> {
    const perPage = Math.min(Math.max(opts.perPage ?? 30, 1), 100);
    const page = Math.max(opts.page ?? 1, 1);
    const token = await this.installationToken(installationId);
    return withRetry(async () => {
      const res = await this.fetchImpl(
        `https://api.github.com/installation/repositories?per_page=${perPage}&page=${page}`,
        {
          method: 'GET',
          headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${token}`,
            'user-agent': 'clawreview',
            'x-github-api-version': '2022-11-28',
          },
        },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new Error(`list installation repos failed: ${res.status} ${text.slice(0, 200)}`);
        (err as { status?: number }).status = res.status;
        throw err;
      }
      const json = (await res.json()) as { total_count: number; repositories: RawRepository[] };
      return {
        totalCount: json.total_count,
        repositories: json.repositories.map(mapRepository),
      };
    });
  }
}
