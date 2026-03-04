import type { Context } from "hono";

import type {
  DatabaseConfig,
  DatabaseConnectionDefinitions,
  InferDbConnectionsFromDatabase,
  InferDbDefaultAndConnections,
} from "./manager";

export type DatabaseContext<
  TDefault = unknown,
  TConnections extends Record<string, unknown> = Record<string, unknown>,
> = TDefault & TConnections;

export type DbContext<
  Env extends Record<string, unknown>,
  TDefault = unknown,
  TConnections extends Record<string, unknown> = Record<string, unknown>,
> = Context<{
  Bindings: Env;
  Variables: {
    db: DatabaseContext<TDefault, TConnections>;
    dbConnections: TConnections;
    auth?: unknown;
  };
}> & {
  db: DatabaseContext<TDefault, TConnections>;
};

export type DatabaseContextFromConfig<
  TDatabase extends DatabaseConfig<any, any>,
> = InferDbDefaultAndConnections<TDatabase>;

export type DatabaseConnectionsFromConfig<
  TDatabase extends DatabaseConfig<any, any>,
> = InferDbConnectionsFromDatabase<TDatabase>;

export function getDb<
  Env extends Record<string, unknown>,
  TDefault,
  TConnections extends Record<string, unknown>,
>(c: DbContext<Env, TDefault, TConnections>): DatabaseContext<TDefault, TConnections> {
  const db = c.get("db") || c.db;
  if (!db) {
    throw new Error("Database context not available. Ensure DB middleware is applied.");
  }
  return db;
}

export function getDbConnections<
  Env extends Record<string, unknown>,
  TConnections extends Record<string, unknown>,
>(
  c: Context<{
    Bindings: Env;
    Variables: { dbConnections: TConnections };
  }>,
): TConnections {
  const dbConnections = c.get("dbConnections");
  if (!dbConnections) {
    throw new Error("Database connections are not available. Ensure DB middleware is applied.");
  }

  return dbConnections;
}

export function getConnectionDbFromContext<
  Env extends Record<string, unknown>,
  TConnections extends Record<string, unknown>,
  TName extends keyof TConnections & string,
>(
  c: Context<{
    Bindings: Env;
    Variables: { dbConnections: TConnections };
  }>,
  connectionName: TName,
): TConnections[TName] {
  const connections = getDbConnections(c);
  const connection = connections[connectionName];

  if (!connection) {
    throw new Error(`Connection \"${connectionName}\" not found in context.`);
  }

  return connection;
}

export type {
  DatabaseAdapter,
  DatabaseAdapterConnectArgs,
  DatabaseConfig,
  DatabaseConnectionDefinition,
  DatabaseConnectionDefinitions,
  DbLifecycleOptions,
  DbLifecycleStrategy,
  InferDbConnectionsFromDatabase,
  InferDbDefaultAndConnections,
  InferDbDefaultClient,
} from "./manager";

export { defineDatabase, DatabaseManager } from "./manager";
