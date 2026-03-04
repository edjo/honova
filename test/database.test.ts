import { describe, expect, it } from "vitest";
import { Hono } from "hono";

import {
  createDbManagerMiddleware,
  defineDatabase,
  type DatabaseAdapter,
  DatabaseManager,
} from "../src/index";

interface FakeClient {
  name: string;
  url: string;
  ping: () => string;
}

function makeAdapter<Env extends Record<string, unknown> = Record<string, unknown>>(
  name: string,
): DatabaseAdapter<Env, unknown, unknown> {
  return {
    name,
    connect: async ({ url }) => ({
      name,
      url,
      ping: () => `${name}:${url}`,
    }),
  };
}

describe("database manager", () => {
  it("supports single DB with c.db default and c.db.<name>", async () => {
    const config = defineDatabase<Record<string, unknown>>()({
      connections: [
        {
          connectionName: "main",
          adapter: makeAdapter("main"),
          url: "postgres://main",
        },
      ],
    });

    const app = new Hono<{ Bindings: Record<string, unknown> }>();
    app.use("*", createDbManagerMiddleware(config));
    app.get("/", (c) => {
      const db = c.db as {
        ping: () => string;
        main: { ping: () => string };
      };

      return c.json({
        defaultPing: db.ping(),
        namedPing: db.main.ping(),
      });
    });

    const response = await app.request("http://localhost/");
    const body = await response.json();

    expect(body.defaultPing).toBe("main:postgres://main");
    expect(body.namedPing).toBe("main:postgres://main");
  });

  it("supports multi DB with defaultConnection and c.db.<name>", async () => {
    const config = defineDatabase<Record<string, unknown>>()({
      defaultConnection: "analytics",
      connections: [
        {
          connectionName: "main",
          adapter: makeAdapter("main"),
          url: "postgres://main",
          eager: true,
        },
        {
          connectionName: "analytics",
          adapter: makeAdapter("analytics"),
          url: "postgres://analytics",
        },
      ],
    });

    const app = new Hono<{ Bindings: Record<string, unknown> }>();
    app.use("*", createDbManagerMiddleware(config));
    app.get("/", (c) => {
      const db = c.db as {
        ping: () => string;
        main: { ping: () => string };
        analytics: { ping: () => string };
      };

      return c.json({
        defaultPing: db.ping(),
        mainPing: db.main.ping(),
        analyticsPing: db.analytics.ping(),
      });
    });

    const response = await app.request("http://localhost/");
    const body = await response.json();

    expect(body.defaultPing).toBe("analytics:postgres://analytics");
    expect(body.mainPing).toBe("main:postgres://main");
    expect(body.analyticsPing).toBe("analytics:postgres://analytics");
  });

  it("throws when multiple DBs are configured without defaultConnection", () => {
    expect(() =>
      new DatabaseManager(
        {},
        {} as never,
        defineDatabase<Record<string, unknown>>()({
          connections: [
            {
              connectionName: "main",
              adapter: makeAdapter("main"),
              url: "postgres://main",
            },
            {
              connectionName: "analytics",
              adapter: makeAdapter("analytics"),
              url: "postgres://analytics",
            },
          ],
        }),
      ),
    ).toThrowError(
      "When multiple database connections are configured, defaultConnection is required.",
    );
  });

  it("resolves URL from resolveUrl per request (hyperdrive-style)", async () => {
    let resolveCalls = 0;

    const config = defineDatabase<{ HYPERDRIVE_DSN: string }>()({
      connections: [
        {
          connectionName: "main",
          adapter: makeAdapter<{ HYPERDRIVE_DSN: string }>("main"),
          resolveUrl: (c) => {
            resolveCalls += 1;
            return c.env.HYPERDRIVE_DSN;
          },
        },
      ],
    });

    const app = new Hono<{ Bindings: { HYPERDRIVE_DSN: string } }>();
    app.use("*", createDbManagerMiddleware(config));
    app.get("/", (c) => {
      const db = c.db as { url: string };
      return c.json({ url: db.url });
    });

    const first = await app.fetch(new Request("http://localhost/"), {
      HYPERDRIVE_DSN: "postgres://request-1",
    } as { HYPERDRIVE_DSN: string }, {} as never);

    const second = await app.fetch(new Request("http://localhost/"), {
      HYPERDRIVE_DSN: "postgres://request-2",
    } as { HYPERDRIVE_DSN: string }, {} as never);

    expect((await first.json()).url).toBe("postgres://request-1");
    expect((await second.json()).url).toBe("postgres://request-2");
    expect(resolveCalls).toBe(2);
  });

  it("initializes only default connection when eager is not enabled", async () => {
    const connectedNames: string[] = [];

    const trackAdapter = (name: string): DatabaseAdapter<Record<string, unknown>, unknown, unknown> => ({
      name,
      connect: async ({ url }) => {
        connectedNames.push(name);
        return { name, url };
      },
    });

    const config = defineDatabase<Record<string, unknown>>()({
      defaultConnection: "main",
      connections: [
        {
          connectionName: "main",
          adapter: trackAdapter("main"),
          url: "postgres://main",
        },
        {
          connectionName: "analytics",
          adapter: trackAdapter("analytics"),
          url: "postgres://analytics",
        },
      ],
    });

    const app = new Hono<{ Bindings: Record<string, unknown> }>();
    app.use("*", createDbManagerMiddleware(config));
    app.get("/", (c) => c.json({ connected: true }));

    const response = await app.request("http://localhost/");
    expect(response.status).toBe(200);
    expect(connectedNames).toEqual(["main"]);
  });

  it("initializes non-default connections when eager is enabled", async () => {
    const connectedNames: string[] = [];

    const trackAdapter = (name: string): DatabaseAdapter<Record<string, unknown>, unknown, unknown> => ({
      name,
      connect: async ({ url }) => {
        connectedNames.push(name);
        return { name, url };
      },
    });

    const config = defineDatabase<Record<string, unknown>>()({
      defaultConnection: "main",
      connections: [
        {
          connectionName: "main",
          adapter: trackAdapter("main"),
          url: "postgres://main",
        },
        {
          connectionName: "analytics",
          adapter: trackAdapter("analytics"),
          url: "postgres://analytics",
          eager: true,
        },
      ],
    });

    const app = new Hono<{ Bindings: Record<string, unknown> }>();
    app.use("*", createDbManagerMiddleware(config));
    app.get("/", (c) => c.json({ connected: true }));

    const response = await app.request("http://localhost/");
    expect(response.status).toBe(200);
    expect(connectedNames).toContain("main");
    expect(connectedNames).toContain("analytics");
  });

  it("does not cleanup automatically when lifecycle strategy is manual", async () => {
    let disconnectCalls = 0;

    const adapter: DatabaseAdapter<Record<string, unknown>, unknown, unknown> = {
      name: "main",
      connect: async ({ url }) => ({ url }),
      disconnect: async () => {
        disconnectCalls += 1;
      },
    };

    const config = defineDatabase<Record<string, unknown>>()({
      lifecycle: { strategy: "manual" },
      connections: [
        {
          connectionName: "main",
          adapter,
          url: "postgres://main",
        },
      ],
    });

    const app = new Hono<{ Bindings: Record<string, unknown> }>();
    app.use("*", createDbManagerMiddleware(config));
    app.get("/", (c) => c.json({ ok: true }));

    const response = await app.request("http://localhost/");
    expect(response.status).toBe(200);
    expect(disconnectCalls).toBe(0);
  });

  it("ignores optional eager connection when URL cannot be resolved", async () => {
    const config = defineDatabase<Record<string, unknown>>()({
      defaultConnection: "main",
      connections: [
        {
          connectionName: "main",
          adapter: makeAdapter("main"),
          url: "postgres://main",
        },
        {
          connectionName: "analytics",
          adapter: makeAdapter("analytics"),
          required: false,
          eager: true,
        },
      ],
    });

    const app = new Hono<{ Bindings: Record<string, unknown> }>();
    app.use("*", createDbManagerMiddleware(config));
    app.get("/", (c) => c.json({ ok: true }));

    const response = await app.request("http://localhost/");
    expect(response.status).toBe(200);
  });

  it("throws when defaultConnection is optional", () => {
    expect(() =>
      new DatabaseManager(
        {},
        {} as never,
        defineDatabase<Record<string, unknown>>()({
          defaultConnection: "main",
          connections: [
            {
              connectionName: "main",
              adapter: makeAdapter("main"),
              url: "postgres://main",
              required: false,
            },
          ],
        }),
      ),
    ).toThrowError("defaultConnection cannot be optional (required must not be false).");
  });
});
