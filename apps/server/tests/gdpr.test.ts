import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setPrismaFactory, type AnyPrismaClient } from '@clawreview/db';

process.env.NODE_ENV = 'test';
process.env.GITHUB_WEBHOOK_SECRET = 'test-secret';
process.env.API_AUTH_TOKENS = 'dashboard:gdpr-test-token';

interface UserRow {
  id: string;
  githubId: bigint;
  login: string;
  email: string | null;
  avatarUrl: string | null;
  createdAt: Date;
}
interface SessionRow {
  id: string;
  userId: string;
  expiresAt: Date;
  createdAt: Date;
}
interface MembershipRow {
  id: string;
  userId: string;
  installationId: string;
  role: string;
  createdAt: Date;
}
interface AuditRow {
  id: string;
  installationId: string | null;
  actorLogin: string;
  action: string;
  subject: string | null;
  metaJson: Record<string, unknown> | null;
  createdAt: Date;
}

const users: UserRow[] = [];
const sessions: SessionRow[] = [];
const memberships: MembershipRow[] = [];
const audits: AuditRow[] = [];
let auditSeq = 0;

function matchWhere<T extends Record<string, unknown>>(row: T, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if ((row as Record<string, unknown>)[k] !== v) return false;
  }
  return true;
}

const fakePrisma = {
  $connect: async () => {},
  $disconnect: async () => {},
  user: {
    findUnique: async ({ where, include }: { where: { login?: string; id?: string }; include?: { sessions?: boolean; memberships?: boolean } }) => {
      const user = users.find((u) => (where.login ? u.login === where.login : u.id === where.id));
      if (!user) return null;
      const out: Record<string, unknown> = { ...user };
      if (include?.sessions) out.sessions = sessions.filter((s) => s.userId === user.id);
      if (include?.memberships) out.memberships = memberships.filter((m) => m.userId === user.id);
      return out;
    },
    delete: async ({ where }: { where: { id: string } }) => {
      const idx = users.findIndex((u) => u.id === where.id);
      if (idx >= 0) users.splice(idx, 1);
      return { id: where.id };
    },
  },
  session: {
    deleteMany: async ({ where }: { where: { userId: string } }) => {
      let count = 0;
      for (let i = sessions.length - 1; i >= 0; i -= 1) {
        if (sessions[i].userId === where.userId) {
          sessions.splice(i, 1);
          count += 1;
        }
      }
      return { count };
    },
  },
  membership: {
    deleteMany: async ({ where }: { where: { userId: string } }) => {
      let count = 0;
      for (let i = memberships.length - 1; i >= 0; i -= 1) {
        if (memberships[i].userId === where.userId) {
          memberships.splice(i, 1);
          count += 1;
        }
      }
      return { count };
    },
  },
  auditLog: {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      auditSeq += 1;
      const row: AuditRow = {
        id: `aud_${String(auditSeq).padStart(4, '0')}`,
        installationId: (data.installationId as string | undefined) ?? null,
        actorLogin: data.actorLogin as string,
        action: data.action as string,
        subject: (data.subject as string | undefined) ?? null,
        metaJson: (data.metaJson as Record<string, unknown> | null) ?? null,
        createdAt: new Date(Date.now() + auditSeq),
      };
      audits.push(row);
      return row;
    },
    findMany: async (args: { where?: Record<string, unknown>; take?: number }) => {
      const where = args.where ?? {};
      const filtered = audits.filter((r) => matchWhere(r, where));
      const sorted = filtered.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return sorted.slice(0, args.take ?? 50);
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      let count = 0;
      for (const row of audits) {
        if (matchWhere(row, where)) {
          if ('actorLogin' in data) row.actorLogin = data.actorLogin as string;
          if ('metaJson' in data) row.metaJson = data.metaJson as Record<string, unknown> | null;
          count += 1;
        }
      }
      return { count };
    },
  },
} as unknown as AnyPrismaClient;

setPrismaFactory(() => fakePrisma);

const { buildServer } = await import('../src/server.js');

const AUTH = { authorization: 'Bearer gdpr-test-token' };

describe('GDPR data lifecycle endpoints', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });
  afterAll(async () => app.close());

  beforeEach(() => {
    users.length = 0;
    sessions.length = 0;
    memberships.length = 0;
    audits.length = 0;
    auditSeq = 0;

    users.push({
      id: 'u_1',
      githubId: 12345n,
      login: 'octocat',
      email: 'octocat@example.com',
      avatarUrl: null,
      createdAt: new Date('2025-01-01T00:00:00Z'),
    });
    sessions.push({ id: 'sess_1', userId: 'u_1', expiresAt: new Date('2026-12-31'), createdAt: new Date('2025-06-01') });
    memberships.push({ id: 'm_1', userId: 'u_1', installationId: 'inst_9', role: 'admin', createdAt: new Date('2025-02-01') });
    audits.push({
      id: 'aud_seed',
      installationId: 'inst_9',
      actorLogin: 'octocat',
      action: 'review.rerun',
      subject: 'pr-7',
      metaJson: { ip: '1.2.3.4' },
      createdAt: new Date('2025-03-01'),
    });
  });

  it('exports user data as a downloadable JSON bundle', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/users/octocat/data-export',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('user-octocat-export.json');
    const body = res.json();
    expect(body.user.login).toBe('octocat');
    expect(body.user.email).toBe('octocat@example.com');
    expect(body.sessions).toHaveLength(1);
    expect(body.memberships[0].installationId).toBe('inst_9');
    expect(body.auditEntries[0].action).toBe('review.rerun');

    // export itself is audited
    expect(audits.some((a) => a.action === 'gdpr.export' && a.subject === 'user:octocat')).toBe(true);
  });

  it('returns 404 for an unknown user on export', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/users/ghostuser/data-export',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
  });

  it('requires auth on /api/users routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/users/octocat/data-export' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects malformed logins', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/users/-bad..login/data-export',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(400);
  });

  it('deletes user, cascades, anonymises audits, leaves trail', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/users/octocat',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const receipt = res.json();
    expect(receipt.login).toBe('octocat');
    expect(receipt.sessionsDeleted).toBe(1);
    expect(receipt.membershipsDeleted).toBe(1);
    expect(receipt.auditEntriesAnonymised).toBe(1);
    expect(receipt.pseudonym).toMatch(/^erased-user-[0-9a-f]{12}$/u);

    expect(users.find((u) => u.login === 'octocat')).toBeUndefined();
    expect(sessions.filter((s) => s.userId === 'u_1')).toHaveLength(0);
    expect(memberships.filter((m) => m.userId === 'u_1')).toHaveLength(0);

    // original audit row is rewritten, not removed
    const seeded = audits.find((a) => a.id === 'aud_seed');
    expect(seeded).toBeTruthy();
    expect(seeded?.actorLogin).toBe(receipt.pseudonym);
    expect(seeded?.metaJson).toBeNull();

    // deletion itself is audited (and the actor is the api token, not octocat)
    const deletionEntry = audits.find((a) => a.action === 'gdpr.delete');
    expect(deletionEntry?.subject).toBe('user:octocat');
    expect(deletionEntry?.actorLogin).toBe('api-token:dashboard');
  });

  it('produces a deterministic pseudonym for the same login', async () => {
    // Recreate the same user a second time and re-delete: same pseudonym.
    const first = await app.inject({ method: 'DELETE', url: '/api/users/octocat', headers: AUTH });
    const pseudo1 = first.json().pseudonym;

    users.push({
      id: 'u_2',
      githubId: 99n,
      login: 'octocat',
      email: null,
      avatarUrl: null,
      createdAt: new Date(),
    });
    const second = await app.inject({ method: 'DELETE', url: '/api/users/octocat', headers: AUTH });
    expect(second.json().pseudonym).toBe(pseudo1);
  });
});
