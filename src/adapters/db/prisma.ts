import type { DatabaseAdapter } from "../../database/manager";

export interface PrismaAdapterOptions<TClient> {
  connect: (url: string) => Promise<TClient> | TClient;
  disconnect?: (client: TClient) => Promise<void> | void;
}

export function createPrismaAdapter<
  Env extends Record<string, unknown>,
  TClient extends { $disconnect?: () => Promise<void> | void },
>(
  options: PrismaAdapterOptions<TClient>,
): DatabaseAdapter<Env, TClient, unknown> {
  return {
    name: "prisma",
    connect: async ({ url }) => options.connect(url),
    disconnect: async (client) => {
      if (options.disconnect) {
        await options.disconnect(client);
        return;
      }

      if (typeof client.$disconnect === "function") {
        await client.$disconnect();
      }
    },
  };
}
