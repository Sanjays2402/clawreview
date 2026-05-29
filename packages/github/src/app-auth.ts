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
}
