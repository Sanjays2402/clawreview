import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setPrismaFactory, type AnyPrismaClient } from '@clawreview/db';

process.env.NODE_ENV = 'test';
process.env.GITHUB_WEBHOOK_SECRET = 'test-secret';

interface AuditRow {
  id: string;
  installationId: string | null;
  actorLogin: string;
  action: string;
  subject: string | null;
  metaJson: Record<string, unknown> | null;
  createdAt: Date;
}

const rows: AuditRow[] = [];
let seq = 0;

function matches(row: AuditRow, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if ((row as unknown as Record<string, unknown>)[k] !== v) return false;
  }
  return true;
}

const fakePrisma = {
  $connect: async () => {},
  $disconnect: async () => {},
  auditLog: {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      seq += 1;
      const row: AuditRow = {
        id: `aud_${String(seq).padStart(4, '0')}`,
        installationId: (data.installationId as string | undefined) ?? null,
        actorLogin: data.actorLogin as string,
        action: data.action as string,
        subject: (data.subject as string | undefined) ?? null,
        metaJson: (data.metaJson as Record<string, unknown> | null) ?? null,
        createdAt: new Date(Date.now() + seq),
      };
      rows.push(row);
      return row;
    },
    findMany: async (args: { where?: Record<string, unknown>; take?: number; cursor?: { id: string }; skip?: number }) => {
      const where = args.where ?? {};
      let filtered = rows.filter((r) => matches(r, where));
      filtered = filtered.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      if (args.cursor) {
        const idx = filtered.findIndex((r) => r.id === args.cursor!.id);
        if (idx >= 0) filtered = filtered.slice(idx + (args.skip ?? 0));
      }
      return filtered.slice(0, args.take ?? 50);
    },
  },
} as unknown as AnyPrismaClient;

setPrismaFactory(() => fakePrisma);

const { buildServer } = await import('../src/server.js');
const { audit, listAudits } = await import('@clawreview/db');

describe('audit log persistence and /api/audit route', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });
  afterAll(async () => app.close());

  beforeEach(() => {
    rows.length = 0;
    seq = 0;
  });

  it('persists rows via audit() and lists them most-recent first', async () => {
    await audit({ installationId: '99', actorLogin: 'sanjay', action: 'review.enqueued', subject: 'sanjay/demo#7' });
    await audit({ installationId: '99', actorLogin: 'dashboard', action: 'budget.updated', subject: 'installation:99', meta: { limitUsd: 75 } });

    const all = await listAudits({});
    expect(all).toHaveLength(2);
    expect(all[0].action).toBe('budget.updated');
    expect(all[1].action).toBe('review.enqueued');

    const filtered = await listAudits({ action: 'review.enqueued' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].subject).toBe('sanjay/demo#7');
  });

  it('GET /api/audit returns persisted rows with nextCursor when paginating', async () => {
    for (let i = 0; i < 5; i += 1) {
      await audit({ installationId: '42', actorLogin: 'sanjay', action: 'review.rerun', subject: `pr-${i}` });
    }

    const first = await app.inject({ method: 'GET', url: '/api/audit?installationId=42&limit=3' });
    expect(first.statusCode).toBe(200);
    const body = first.json();
    expect(body.items).toHaveLength(3);
    expect(body.items.every((r: AuditRow) => r.installationId === '42')).toBe(true);
    expect(body.nextCursor).toBeTruthy();

    const second = await app.inject({ method: 'GET', url: `/api/audit?installationId=42&limit=3&cursor=${body.nextCursor}` });
    expect(second.statusCode).toBe(200);
    expect(second.json().items).toHaveLength(2);
  });

  it('GET /api/audit rejects bad query', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/audit?limit=500' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('BadQuery');
  });

  it('audit() swallows backend errors and logs', async () => {
    const warnings: unknown[] = [];
    const breaking = {
      $connect: async () => {},
      $disconnect: async () => {},
      auditLog: {
        create: async () => {
          throw new Error('boom');
        },
        findMany: async () => [],
      },
    } as unknown as AnyPrismaClient;
    setPrismaFactory(() => breaking);
    try {
      await audit(
        { actorLogin: 'sanjay', action: 'test.fail' },
        { logger: { warn: (obj) => warnings.push(obj) } },
      );
      expect(warnings).toHaveLength(1);
    } finally {
      setPrismaFactory(() => fakePrisma);
    }
  });
});
