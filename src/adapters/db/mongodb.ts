import type { DatabaseAdapter } from "../../database/manager";

export interface MongoDbAdapterOptions<TClient, TConnectOptions> {
  connect: (url: string, options: TConnectOptions) => Promise<TClient> | TClient;
  disconnect?: (client: TClient) => Promise<void> | void;
}

export function createMongoDbAdapter<
  Env extends Record<string, unknown>,
  TClient,
  TConnectOptions,
>(
  adapterOptions: MongoDbAdapterOptions<TClient, TConnectOptions>,
): DatabaseAdapter<Env, TClient, TConnectOptions> {
  return {
    name: "mongodb",
    connect: async ({ url, options }) => adapterOptions.connect(url, options),
    disconnect: adapterOptions.disconnect,
  };
}
