import type { DatabaseAdapter } from "../../database/manager";

export interface DrizzleAdapterOptions<TClient> {
  connect: (url: string) => Promise<TClient> | TClient;
  disconnect?: (client: TClient) => Promise<void> | void;
}

export function createDrizzleAdapter<
  Env extends Record<string, unknown>,
  TClient,
>(
  options: DrizzleAdapterOptions<TClient>,
): DatabaseAdapter<Env, TClient, unknown> {
  return {
    name: "drizzle",
    connect: async ({ url }) => options.connect(url),
    disconnect: options.disconnect,
  };
}
