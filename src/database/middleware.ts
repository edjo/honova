import { createMiddleware } from "hono/factory";

import {
  DatabaseManager,
  type DatabaseConfig,
  type DatabaseConnectionDefinitions,
  type InferDbConnectionsFromDatabase,
  type InferDbDefaultAndConnections,
} from "./manager";

export type DbManagerMiddlewareOptions<
  Env extends Record<string, unknown>,
> = DatabaseConfig<Env, DatabaseConnectionDefinitions<Env>>;

export function createDbManagerMiddleware<
  const TDatabase extends DatabaseConfig<any, any>,
>(config: TDatabase) {
  type Env = TDatabase extends DatabaseConfig<infer TEnv, any>
    ? TEnv
    : Record<string, unknown>;
  type DbConnections = InferDbConnectionsFromDatabase<TDatabase>;
  type DbDefaultAndConnections = InferDbDefaultAndConnections<TDatabase>;
  type Manager = DatabaseManager<Env, TDatabase>;

  return createMiddleware<{
    Bindings: Env;
    Variables: {
      dbManager: Manager;
      db: DbDefaultAndConnections;
      dbConnections: DbConnections;
    };
  }>(async (c, next) => {
    const lifecycleStrategy = config.lifecycle?.strategy ?? "request";
    const manager = new DatabaseManager(
      c.env,
      c as unknown as import("hono").Context<{
        Bindings: Env;
        Variables: Record<string, unknown>;
      }>,
      config,
    );
    c.set("dbManager", manager);

    try {
      const db = await manager.initialize();
      const dbConnections = manager.connections;

      c.set("db", db);
      c.set("dbConnections", dbConnections);

      (c as unknown as { db: DbDefaultAndConnections }).db = db;

      await next();
    } finally {
      if (lifecycleStrategy === "request") {
        await manager.cleanup();
      }
    }
  });
}

declare module "hono" {
  interface ContextVariableMap {
    dbManager: unknown;
    db: Record<string, unknown>;
    dbConnections: Record<string, unknown>;
  }

  interface Context {
    db: Record<string, unknown>;
  }
}
