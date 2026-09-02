import { describe, expect, it, vi } from "vitest";

import { createDbManagerMiddleware, defineDatabase } from "../src/index";
import { Hono } from "hono";

/**
 * A `lazy` default connection stays typed and usable on `c.db`, but is not
 * opened until a query is actually issued.
 *
 * This matters on serverless runtimes with a bounded origin connection budget
 * (Hyperdrive, RDS Proxy): health checks, 404s and rejected requests are a large
 * share of traffic, and none of them should take a connection.
 */
type Env = { DATABASE_URL: string };

function fixture(options: { lazy: boolean }) {
  const connect = vi.fn(() => ({
    user: {
      findFirst: (id: string) => ({ id, source: "real-client" }),
    },
  }));

  const database = defineDatabase<Env>()({
    connections: [
      {
        connectionName: "main",
        lazy: options.lazy,
        adapter: { name: "test", connect },
        urlFromEnv: "DATABASE_URL",
      },
    ],
  });

  const app = new Hono<{ Bindings: Env }>();
  app.use("*", createDbManagerMiddleware(database) as never);

  return { app, connect };
}

const env = { DATABASE_URL: "postgres://localhost/test" };

describe("lazy database connections", () => {
  it("does not connect for a request that never queries", async () => {
    const { app, connect } = fixture({ lazy: true });
    app.get("/health", (c) => c.json({ ok: true }));

    const response = await app.fetch(new Request("http://local/health"), env);

    expect(response.status).toBe(200);
    expect(connect).not.toHaveBeenCalled();
  });

  it("connects on the first query, transparently through c.db", async () => {
    const { app, connect } = fixture({ lazy: true });
    app.get("/user", async (c) => {
      // Exactly the shape application code writes — no manager, no await on the
      // connection itself.
      const user = await (c as never as { db: { user: { findFirst(id: string): Promise<unknown> } } })
        .db.user.findFirst("u1");

      return c.json(user as Record<string, unknown>);
    });

    const response = await app.fetch(new Request("http://local/user"), env);

    await expect(response.json()).resolves.toEqual({ id: "u1", source: "real-client" });
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("reuses the connection for the rest of the request", async () => {
    const { app, connect } = fixture({ lazy: true });
    app.get("/twice", async (c) => {
      const db = (c as never as { db: { user: { findFirst(id: string): Promise<unknown> } } }).db;
      await db.user.findFirst("a");
      await db.user.findFirst("b");

      return c.json({ ok: true });
    });

    await app.fetch(new Request("http://local/twice"), env);

    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("connects up front when the connection is not lazy", async () => {
    const { app, connect } = fixture({ lazy: false });
    app.get("/health", (c) => c.json({ ok: true }));

    await app.fetch(new Request("http://local/health"), env);

    expect(connect).toHaveBeenCalledTimes(1);
  });

  /** `await c.db` must not look like a thenable and hang. */
  it("does not masquerade as a promise", async () => {
    const { app } = fixture({ lazy: true });
    app.get("/await-db", async (c) => {
      const db = await (c as never as { db: unknown }).db;

      return c.json({ resolved: db !== undefined });
    });

    const response = await app.fetch(new Request("http://local/await-db"), env);

    await expect(response.json()).resolves.toEqual({ resolved: true });
  });
});
