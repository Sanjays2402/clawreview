import { getPrisma } from './client.js';

export interface AuditEntryInput {
  installationId?: string;
  actorLogin: string;
  action: string;
  subject?: string;
  meta?: Record<string, unknown>;
}

export async function audit(entry: AuditEntryInput): Promise<void> {
  const prisma = getPrisma() as unknown as {
    auditLog: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> };
  };
  await prisma.auditLog.create({
    data: {
      installationId: entry.installationId,
      actorLogin: entry.actorLogin,
      action: entry.action,
      subject: entry.subject,
      metaJson: entry.meta ?? null,
    },
  });
}
