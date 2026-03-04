import type { Context as HonoContext } from "hono";

export type AppContext<
  Env extends Record<string, unknown> = Record<string, unknown>,
  TDbDefault = unknown,
  TDbConnections extends Record<string, unknown> = Record<string, unknown>,
> = HonoContext<{
  Bindings: Env;
  Variables: {
    db: TDbDefault & TDbConnections;
    dbConnections: TDbConnections;
    auth?: unknown;
  };
}> & {
  db: TDbDefault & TDbConnections;
};
