import { getPrisma } from './client.js';
import { createHash } from 'node:crypto';

/**
 * GDPR / data lifecycle helpers.
 *
 * These functions operate on a User row identified by GitHub `login`.
 * `exportUserData` is a read-only dump suitable for the right-to-access
 * deliverable. `deleteUserData` enforces the right-to-erasure by removing
 * the User row (which cascades to Session and Membership via the schema)
 * and by anonymising audit log entries that name the user as the actor so
 * the audit trail stays intact but no longer contains PII.
 *
 * Audit log rows themselves are NOT removed: deleting them would defeat
 * the security purpose of the log. We replace `actorLogin` with a stable
 * pseudonym and strip `metaJson`.
 */

export interface UserExport {
  exportedAt: string;
  user: {
    id: string;
    githubId: string;
    login: string;
    email: string | null;
    avatarUrl: string | null;
    createdAt: Date;
  };
  sessions: Array<{ id: string; expiresAt: Date; createdAt: Date }>;
  memberships: Array<{
    id: string;
    installationId: string;
    role: string;
    createdAt: Date;
  }>;
  auditEntries: Array<{
    id: string;
    installationId: string | null;
    action: string;
    subject: string | null;
    createdAt: Date;
  }>;
}

export interface UserDeletionReceipt {
  login: string;
  deletedUserId: string | null;
  sessionsDeleted: number;
  membershipsDeleted: number;
  auditEntriesAnonymised: number;
  pseudonym: string;
  completedAt: string;
}

type UserDelegate = {
  findUnique: (args: { where: { login?: string }; include?: unknown }) => Promise<unknown>;
  delete: (args: { where: { id: string } }) => Promise<unknown>;
};
type SessionDelegate = {
  deleteMany: (args: { where: Record<string, unknown> }) => Promise<{ count: number }>;
};
type MembershipDelegate = {
  deleteMany: (args: { where: Record<string, unknown> }) => Promise<{ count: number }>;
};
type AuditDelegate = {
  findMany: (args: Record<string, unknown>) => Promise<unknown[]>;
  updateMany: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<{ count: number }>;
};

interface PrismaShape {
  user: UserDelegate;
  session: SessionDelegate;
  membership: MembershipDelegate;
  auditLog: AuditDelegate;
}

function getDb(): PrismaShape {
  return getPrisma() as unknown as PrismaShape;
}

interface UserRow {
  id: string;
  githubId: bigint | number | string;
  login: string;
  email: string | null;
  avatarUrl: string | null;
  createdAt: Date;
  sessions?: Array<{ id: string; expiresAt: Date; createdAt: Date }>;
  memberships?: Array<{ id: string; installationId: string; role: string; createdAt: Date }>;
}

/**
 * Build the full export bundle for a single user. Returns null when no
 * matching user exists so callers can surface a 404 cleanly.
 */
export async function exportUserData(login: string): Promise<UserExport | null> {
  const db = getDb();
  const user = (await db.user.findUnique({
    where: { login },
    include: { sessions: true, memberships: true },
  })) as UserRow | null;
  if (!user) return null;

  const audits = (await db.auditLog.findMany({
    where: { actorLogin: login },
    orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
    take: 1000,
  })) as Array<{
    id: string;
    installationId: string | null;
    action: string;
    subject: string | null;
    createdAt: Date;
  }>;

  return {
    exportedAt: new Date().toISOString(),
    user: {
      id: user.id,
      githubId: String(user.githubId),
      login: user.login,
      email: user.email,
      avatarUrl: user.avatarUrl,
      createdAt: user.createdAt,
    },
    sessions: (user.sessions ?? []).map((s) => ({
      id: s.id,
      expiresAt: s.expiresAt,
      createdAt: s.createdAt,
    })),
    memberships: (user.memberships ?? []).map((m) => ({
      id: m.id,
      installationId: m.installationId,
      role: m.role,
      createdAt: m.createdAt,
    })),
    auditEntries: audits,
  };
}

/**
 * Build a deterministic pseudonym for an erased user. Same input always
 * produces the same pseudonym so audit rows for the same person remain
 * correlatable after deletion, but the original login cannot be recovered
 * without the original input (one-way SHA-256, truncated).
 */
function pseudonymFor(login: string): string {
  const h = createHash('sha256').update(`gdpr:${login}`).digest('hex');
  return `erased-user-${h.slice(0, 12)}`;
}

/**
 * Erase a user. Sessions and memberships cascade-delete from the User row.
 * Audit entries authored by the user are kept (regulatory necessity) but
 * have their actor login replaced with a stable pseudonym and any free-form
 * meta payload cleared.
 *
 * Returns a receipt describing what was removed, suitable for handing back
 * to a DPO or storing as evidence of fulfilment.
 */
export async function deleteUserData(login: string): Promise<UserDeletionReceipt | null> {
  const db = getDb();
  const user = (await db.user.findUnique({ where: { login } })) as UserRow | null;
  if (!user) return null;

  const pseudonym = pseudonymFor(login);

  // Anonymise audit rows first. If this fails we have not yet altered the
  // user record, so the operation is safely retryable.
  const auditUpdate = await db.auditLog.updateMany({
    where: { actorLogin: login },
    data: { actorLogin: pseudonym, metaJson: null },
  });

  // Capture counts before cascade. Schema declares onDelete: Cascade for
  // Session and Membership, so a single user.delete is sufficient, but we
  // count explicitly so the receipt is exact.
  const sessionsDeleted = await db.session.deleteMany({ where: { userId: user.id } });
  const membershipsDeleted = await db.membership.deleteMany({ where: { userId: user.id } });
  await db.user.delete({ where: { id: user.id } });

  return {
    login,
    deletedUserId: user.id,
    sessionsDeleted: sessionsDeleted.count,
    membershipsDeleted: membershipsDeleted.count,
    auditEntriesAnonymised: auditUpdate.count,
    pseudonym,
    completedAt: new Date().toISOString(),
  };
}
