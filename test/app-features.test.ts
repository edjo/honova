import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "hono";

import {
  CONFIG,
  Controller,
  Cron,
  Get,
  HttpQuery,
  Inject,
  Injectable,
  Module,
  Post,
  createApp,
  createApplicationContext,
  createScheduledDispatcher,
  createTestingModule,
  getRequestId,
  type ScheduledContext,
  type StandardSchemaV1,
} from "../src/index";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const stubExecutionCtx = {
  waitUntil(): void {},
  passThroughOnException(): void {},
};

function schemaOf<T>(
  validate: (value: unknown) => { value: T } | { issues: Array<{ message: string }> },
): StandardSchemaV1<unknown, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "test",
      validate,
    },
  };
}

// ---------------------------------------------------------------------------
// 1. CORS opt-in
// ---------------------------------------------------------------------------

@Controller("/cors")
class CorsController {
  @Get("/")
  handle(): Response {
    return Response.json({ ok: true });
  }
}

@Module({ controllers: [CorsController] })
class CorsModule {}

describe("CORS opt-in", () => {
  it("does not set access-control-allow-origin by default", async () => {
    const app = createApp();
    app.registerModule(CorsModule);

    const response = await app
      .getHono()
      .request("http://localhost/cors", { headers: { origin: "https://x.dev" } });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("applies hono's permissive defaults with security.cors: true", async () => {
    const app = createApp({ security: { cors: true } });
    app.registerModule(CorsModule);

    const response = await app
      .getHono()
      .request("http://localhost/cors", { headers: { origin: "https://x.dev" } });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("respects a configured origin with security.cors: { origin }", async () => {
    const app = createApp({ security: { cors: { origin: "https://x.dev" } } });
    app.registerModule(CorsModule);

    const allowed = await app
      .getHono()
      .request("http://localhost/cors", { headers: { origin: "https://x.dev" } });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://x.dev");

    const other = await app
      .getHono()
      .request("http://localhost/cors", { headers: { origin: "https://evil.dev" } });
    expect(other.headers.get("access-control-allow-origin")).not.toBe("https://evil.dev");
  });
});

// ---------------------------------------------------------------------------
// 2. config option (env validation + CONFIG provider)
// ---------------------------------------------------------------------------

interface AppConfig {
  port: number;
}

const envSchema = schemaOf<AppConfig>((value) => {
  const env = value as Record<string, unknown>;
  if (typeof env.PORT !== "string" || Number.isNaN(Number(env.PORT))) {
    return { issues: [{ message: "PORT must be a numeric string" }] };
  }

  // Transform: the parsed value differs from the raw env binding.
  return { value: { port: Number(env.PORT) } };
});

@Controller("/config")
class ConfigController {
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  @Get("/")
  handle(): Response {
    return Response.json({
      port: this.config.port,
      portType: typeof this.config.port,
    });
  }
}

@Module({ controllers: [ConfigController] })
class ConfigModule {}

describe("config option", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("validates env on first request and injects the PARSED value under CONFIG", async () => {
    const app = createApp({ config: { schema: envSchema } });
    app.registerModule(ConfigModule);

    const response = await app.fetch(
      new Request("http://localhost/config"),
      { PORT: "8080" },
      stubExecutionCtx,
    );
    const body = (await response.json()) as { port: number; portType: string };

    expect(response.status).toBe(200);
    expect(body.port).toBe(8080);
    expect(body.portType).toBe("number");
  });

  it("fails every request with 500 when env validation fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const app = createApp({ config: { schema: envSchema } });
    app.registerModule(ConfigModule);

    const first = await app.fetch(
      new Request("http://localhost/config"),
      { PORT: "not-a-number" },
      stubExecutionCtx,
    );
    expect(first.status).toBe(500);
    const firstBody = (await first.json()) as { error: { code: string; message: string } };
    expect(firstBody.error.code).toBe("internal_error");

    const second = await app.fetch(
      new Request("http://localhost/config"),
      { PORT: "not-a-number" },
      stubExecutionCtx,
    );
    expect(second.status).toBe(500);
    const secondBody = (await second.json()) as { error: { code: string } };
    expect(secondBody.error.code).toBe("internal_error");
  });
});

// ---------------------------------------------------------------------------
// 3. QUERY verb
// ---------------------------------------------------------------------------

@Controller("/catalog")
class CatalogController {
  @HttpQuery("/search")
  search(): Response {
    return Response.json({ verb: "QUERY" });
  }
}

@Module({ controllers: [CatalogController] })
class CatalogModule {}

describe("QUERY verb", () => {
  it("routes @HttpQuery handlers for the QUERY method", async () => {
    const app = createApp();
    app.registerModule(CatalogModule);

    const request = new Request("http://localhost/catalog/search", { method: "QUERY" });
    const response = await app.getHono().request(request);
    const body = (await response.json()) as { verb: string };

    expect(response.status).toBe(200);
    expect(body.verb).toBe("QUERY");
  });

  it("does not answer QUERY routes for GET", async () => {
    const app = createApp();
    app.registerModule(CatalogModule);

    const response = await app.getHono().request("http://localhost/catalog/search");
    expect(response.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 4. methodNotAllowed option
// ---------------------------------------------------------------------------

@Controller("/only-get")
class OnlyGetController {
  @Get("/")
  handle(): Response {
    return Response.json({ ok: true });
  }
}

@Module({ controllers: [OnlyGetController] })
class OnlyGetModule {}

describe("methodNotAllowed option", () => {
  it("returns 405 with an Allow header for a wrong method on a known path", async () => {
    const app = createApp({ methodNotAllowed: true });
    app.registerModule(OnlyGetModule);

    const response = await app
      .getHono()
      .request("http://localhost/only-get", { method: "POST" });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toContain("GET");
  });

  it("returns 404 for a wrong method when the option is off", async () => {
    const app = createApp();
    app.registerModule(OnlyGetModule);

    const response = await app
      .getHono()
      .request("http://localhost/only-get", { method: "POST" });
    const body = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// 5. createTestingModule
// ---------------------------------------------------------------------------

@Injectable()
class GreetingService {
  greet(): string {
    return "real greeting";
  }
}

@Controller("/greetings")
class GreetingController {
  constructor(private readonly greetingService: GreetingService) {}

  @Get("/")
  handle(): Response {
    return Response.json({ message: this.greetingService.greet() });
  }
}

@Controller("/echo")
class EchoController {
  @Post("/")
  async handle(c: Context): Promise<unknown> {
    return {
      body: await c.req.json(),
      contentType: c.req.header("content-type"),
    };
  }
}

const backgroundState = { flushed: false };

@Controller("/tasks")
class TaskController {
  @Get("/")
  handle(c: Context): Response {
    c.executionCtx.waitUntil(
      new Promise<void>((resolve) => setTimeout(resolve, 10)).then(() => {
        backgroundState.flushed = true;
      }),
    );

    return Response.json({ scheduled: true });
  }
}

describe("createTestingModule", () => {
  it("compiles inline controllers and providers", async () => {
    const testApp = createTestingModule({
      controllers: [GreetingController],
      providers: [GreetingService],
    }).compile();

    const response = await testApp.request("/greetings");
    const body = (await response.json()) as { message: string };

    expect(response.status).toBe(200);
    expect(body.message).toBe("real greeting");
  });

  it("overrideProvider(...).useValue replaces the provider seen by routes", async () => {
    const fake = { greet: (): string => "fake greeting" };

    const testApp = createTestingModule({
      controllers: [GreetingController],
      providers: [GreetingService],
    })
      .overrideProvider(GreetingService)
      .useValue(fake)
      .compile();

    const response = await testApp.request("/greetings");
    const body = (await response.json()) as { message: string };

    expect(response.status).toBe(200);
    expect(body.message).toBe("fake greeting");

    const resolved = await testApp.resolve<typeof fake>(GreetingService);
    expect(resolved).toBe(fake);
  });

  it("request(path, { json }) sends a JSON body with content-type", async () => {
    const testApp = createTestingModule({
      controllers: [EchoController],
    }).compile();

    const response = await testApp.request("/echo", { method: "POST", json: { a: 1 } });
    const body = (await response.json()) as {
      body: { a: number };
      contentType: string;
    };

    expect(response.status).toBe(200);
    expect(body.body).toEqual({ a: 1 });
    expect(body.contentType).toContain("application/json");
  });

  it("flushWaitUntil awaits promises scheduled via executionCtx.waitUntil", async () => {
    backgroundState.flushed = false;

    const testApp = createTestingModule({
      controllers: [TaskController],
    }).compile();

    const response = await testApp.request("/tasks");
    expect(response.status).toBe(200);
    expect(backgroundState.flushed).toBe(false);

    await testApp.flushWaitUntil();
    expect(backgroundState.flushed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Scheduling (@Cron + createScheduledDispatcher)
// ---------------------------------------------------------------------------

const cronLog: string[] = [];

@Injectable()
class CronClock {
  now(): string {
    return "tick";
  }
}

@Injectable()
class FiveMinuteJobs {
  constructor(private readonly cronClock: CronClock) {}

  @Cron("*/5 * * * *")
  handle(context: ScheduledContext): void {
    cronLog.push(`five:${this.cronClock.now()}:${context.cron}`);
  }
}

@Injectable()
class WildcardJobs {
  @Cron("*")
  handle(context: ScheduledContext): void {
    cronLog.push(`wild:${context.cron}`);
  }
}

@Injectable()
class ExplodingJobs {
  @Cron("*")
  handle(): void {
    cronLog.push("boom:attempted");
    throw new Error("cron exploded");
  }
}

@Module({ providers: [CronClock, FiveMinuteJobs, WildcardJobs, ExplodingJobs] })
class CronModule {}

describe("scheduling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs exact-match and wildcard jobs with DI deps, isolating job errors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    cronLog.length = 0;

    const app = createApp();
    app.registerModule(CronModule);
    const dispatcher = createScheduledDispatcher<Record<string, unknown>>(app);

    await expect(
      dispatcher(
        { cron: "*/5 * * * *", scheduledTime: 0 },
        {},
        { waitUntil(): void {} },
      ),
    ).resolves.toBeUndefined();

    expect(cronLog).toContain("five:tick:*/5 * * * *");
    expect(cronLog).toContain("wild:*/5 * * * *");
    // The throwing job ran but its error stayed isolated (dispatcher resolved).
    expect(cronLog).toContain("boom:attempted");
  });

  it("does not run jobs whose expression does not match the trigger", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    cronLog.length = 0;

    const app = createApp();
    app.registerModule(CronModule);
    const dispatcher = createScheduledDispatcher<Record<string, unknown>>(app);

    await dispatcher(
      { cron: "0 0 * * *", scheduledTime: 0 },
      {},
      { waitUntil(): void {} },
    );

    expect(cronLog.some((entry) => entry.startsWith("five:"))).toBe(false);
    expect(cronLog).toContain("wild:0 0 * * *");
  });
});

// ---------------------------------------------------------------------------
// 7. createApplicationContext (standalone, HTTP-less)
// ---------------------------------------------------------------------------

@Injectable()
class StandaloneDep {
  readonly value = "dep";
}

@Injectable()
class StandaloneService {
  constructor(private readonly standaloneDep: StandaloneDep) {}

  describeSelf(): string {
    return `service:${this.standaloneDep.value}`;
  }
}

@Controller("/standalone")
class StandaloneController {
  @Get("/")
  handle(): Response {
    return Response.json({ ok: true });
  }
}

@Module({
  controllers: [StandaloneController],
  providers: [StandaloneDep, StandaloneService],
})
class StandaloneModule {}

describe("createApplicationContext", () => {
  it("resolves providers with dependencies and ignores controllers", async () => {
    const context = createApplicationContext([StandaloneModule]);

    const service = await context.resolveAsync(StandaloneService);
    expect(service.describeSelf()).toBe("service:dep");

    const providers = context.getRegisteredProviders();
    expect(providers).toContain(StandaloneDep);
    expect(providers).toContain(StandaloneService);
    expect(providers).not.toContain(StandaloneController);

    expect(context.container.has(StandaloneController)).toBe(false);
    await expect(context.resolveAsync(StandaloneController)).rejects.toThrowError(
      /No provider found/,
    );
  });
});

describe("request id propagation", () => {
  it("publishes the request id on the context for handlers and filters", async () => {
    @Controller("/rid")
    class RidController {
      @Get("/")
      read(c: any) {
        return { fromContext: getRequestId(c) };
      }
    }

    @Module({ controllers: [RidController] })
    class RidModule {}

    const app = createApp();
    app.registerModule(RidModule);

    const response = await app.fetch(new Request("http://local/rid"), {} as any, {
      waitUntil() {},
    } as any);
    const body = (await response.json()) as { fromContext?: string };

    expect(body.fromContext).toBeTruthy();
    expect(response.headers.get("x-request-id")).toBe(body.fromContext);
  });

  it("reuses a well-formed client id and rejects an injection-shaped one", async () => {
    @Controller("/rid2")
    class Rid2Controller {
      @Get("/")
      read(c: any) {
        return { id: getRequestId(c) };
      }
    }

    @Module({ controllers: [Rid2Controller] })
    class Rid2Module {}

    const app = createApp();
    app.registerModule(Rid2Module);

    const reused = await app.fetch(
      new Request("http://local/rid2", { headers: { "x-request-id": "trace-123" } }),
      {} as any,
      { waitUntil() {} } as any,
    );
    expect(((await reused.json()) as { id: string }).id).toBe("trace-123");

    const minted = await app.fetch(
      new Request("http://local/rid2", { headers: { "x-request-id": "has spaces" } }),
      {} as any,
      { waitUntil() {} } as any,
    );
    expect(((await minted.json()) as { id: string }).id).not.toBe("has spaces");
  });
});
