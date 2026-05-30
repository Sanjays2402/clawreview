import { getPrisma } from './client.js';

export interface AuditEntryInput {
  installationId?: string;
  actorLogin: string;
  action: string;
  subject?: string;
  meta?: Record<string, unknown>;
}

export interface AuditRecord {
  id: string;
  installationId: string | null;
  actorLogin: string;
  action: string;
  subject: string | null;
  metaJson: Record<string, unknown> | null;
  createdAt: Date;
}

export interface AuditListFilter {
  installationId?: string;
  actorLogin?: string;
  action?: string;
  limit?: number;
  cursor?: string;
}

type AuditDelegate = {
  create: (args: { data: Record<string, unknown> }) => Promise<unknown>;
  findMany: (args: Record<string, unknown>) => Promise<AuditRecord[]>;
  count?: (args: Record<string, unknown>) => Promise<number>;
};

function getDelegate(): AuditDelegate {
  const prisma = getPrisma() as unknown as { auditLog: AuditDelegate };
  return prisma.auditLog;
}

/**
 * Persist an audit row. Failures are swallowed and surfaced via the
 * optional logger so a transient DB problem cannot break the caller's
 * request path. This is the standard contract for audit pipelines:
 * loss-tolerant writes, best-effort durability.
 */
export async function audit(
  entry: AuditEntryInput,
  opts?: { logger?: { warn: (obj: unknown, msg?: string) => void } },
): Promise<void> {
  try {
    await getDelegate().create({
      data: {
        installationId: entry.installationId,
        actorLogin: entry.actorLogin,
        action: entry.action,
        subject: entry.subject,
        metaJson: entry.meta ?? null,
      },
    });
  } catch (err) {
    opts?.logger?.warn(
      { err: (err as Error).message, action: entry.action, actor: entry.actorLogin },
      'audit write failed',
    );
  }
}

/**
 * Read recent audit entries. Most recent first, capped at 200 per page.
 * Filters compose with AND semantics. `cursor` is an audit id; rows
 * strictly older than that id (by createdAt then id tiebreak) are
 * returned, matching Prisma's cursor pagination contract.
 */
export async function listAudits(filter: AuditListFilter = {}): Promise<AuditRecord[]> {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const where: Record<string, unknown> = {};
  if (filter.installationId) where.installationId = filter.installationId;
  if (filter.actorLogin) where.actorLogin = filter.actorLogin;
  if (filter.action) where.action = filter.action;

  const args: Record<string, unknown> = {
    where,
    orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
    take: limit,
  };
  if (filter.cursor) {
    args.cursor = { id: filter.cursor };
    args.skip = 1;
  }
  return getDelegate().findMany(args);
}
