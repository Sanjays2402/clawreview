/**
 * Prisma client wrapper with lazy initialization. The `@prisma/client` import
 * is deferred so that the rest of the workspace can build without a generated
 * client, and so tests can swap in a mock through `setPrisma`.
 */

export type AnyPrismaClient = {
  $connect: () => Promise<void>;
  $disconnect: () => Promise<void>;
  [key: string]: unknown;
};

let client: AnyPrismaClient | null = null;
let factory: (() => AnyPrismaClient) | null = null;

export function setPrismaFactory(f: () => AnyPrismaClient): void {
  factory = f;
  client = null;
}

export function setPrisma(c: AnyPrismaClient): void {
  client = c;
}

export function getPrisma(): AnyPrismaClient {
  if (client) return client;
  if (factory) {
    client = factory();
    return client;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@prisma/client') as { PrismaClient: new () => AnyPrismaClient };
    client = new mod.PrismaClient();
    return client;
  } catch (err) {
    throw new Error(
      `Prisma client is not generated. Run 'pnpm --filter @clawreview/db run generate' first. Original: ${(err as Error).message}`,
    );
  }
}

export async function disconnect(): Promise<void> {
  if (!client) return;
  await client.$disconnect();
  client = null;
}
