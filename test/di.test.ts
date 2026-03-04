import { describe, expect, it } from "vitest";

import { Controller, Get, Injectable, Module, createApp } from "../src/index";
import { setModuleMetadata } from "../src/core/metadata";

@Injectable()
class PingService {
  ping(): string {
    return "pong";
  }
}

@Controller("/health")
class HealthController {
  constructor(private readonly pingService: PingService) {}

  @Get("/")
  handle(): Response {
    return Response.json({ ok: this.pingService.ping() });
  }
}

@Module({
  controllers: [HealthController],
  providers: [PingService],
})
class HealthModule {}

@Controller("/missing")
class MissingController {
  constructor(private readonly missingService: PingService) {}

  @Get("/")
  handle(): Response {
    return Response.json({ ok: this.missingService.ping() });
  }
}

@Module({
  controllers: [MissingController],
  providers: [],
})
class MissingModule {}

class NonInjectableService {
  ping(): string {
    return "pong";
  }
}

@Controller("/non-injectable")
class NonInjectableController {
  constructor(private readonly nonInjectableService: NonInjectableService) {}

  @Get("/")
  handle(): Response {
    return Response.json({ ok: this.nonInjectableService.ping() });
  }
}

@Module({
  controllers: [NonInjectableController],
  providers: [NonInjectableService],
})
class NonInjectableModule {}

@Injectable()
class LifecycleService {
  public initCount = 0;
  public lastPath: string | null = null;

  onModuleInit(context?: { req?: { path?: string } }): void {
    this.initCount += 1;
    this.lastPath = context?.req?.path ?? null;
  }
}

@Controller("/lifecycle")
class LifecycleController {
  constructor(private readonly lifecycleService: LifecycleService) {}

  @Get("/")
  handle(): Response {
    return Response.json({
      initCount: this.lifecycleService.initCount,
      path: this.lifecycleService.lastPath,
    });
  }
}

@Module({
  controllers: [LifecycleController],
  providers: [LifecycleService],
})
class LifecycleModule {}

class CircularModuleA {}
class CircularModuleB {}

setModuleMetadata(CircularModuleA, {
  imports: [CircularModuleB],
});

setModuleMetadata(CircularModuleB, {
  imports: [CircularModuleA],
});

@Controller("/shared")
class SharedController {
  @Get("/")
  handle(): Response {
    return Response.json({ ok: true });
  }
}

@Module({
  controllers: [SharedController],
})
class SharedModuleA {}

@Module({
  controllers: [SharedController],
})
class SharedModuleB {}

@Module({
  imports: [SharedModuleA, SharedModuleB],
})
class RootSharedModule {}

let requestScopedInstanceCount = 0;
let transientInstanceCount = 0;

@Injectable({ scope: "request" })
class RequestScopedService {
  readonly instanceId: number;

  constructor() {
    requestScopedInstanceCount += 1;
    this.instanceId = requestScopedInstanceCount;
  }
}

@Injectable({ scope: "transient" })
class TransientService {
  readonly instanceId: number;

  constructor() {
    transientInstanceCount += 1;
    this.instanceId = transientInstanceCount;
  }
}

@Module({
  providers: [RequestScopedService, TransientService],
})
class ScopedProvidersModule {}

describe("dependency injection", () => {
  it("injects controller constructor dependencies from module providers by param name", async () => {
    const app = createApp();
    app.registerModule(HealthModule);

    const response = await app.getHono().request("http://localhost/health");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe("pong");
  });

  it("fails when provider is not registered in module", async () => {
    const app = createApp();
    app.registerModule(MissingModule);

    const response = await app.getHono().request("http://localhost/missing");
    expect(response.status).toBe(500);
  });

  it("requires @Injectable() on providers", () => {
    const app = createApp();
    expect(() => app.registerModule(NonInjectableModule)).toThrowError(
      "Provider NonInjectableService in NonInjectableModule must be decorated with @Injectable().",
    );
  });

  it("invokes onModuleInit with request context on first provider resolution", async () => {
    const app = createApp();
    app.registerModule(LifecycleModule);

    const responseA = await app.getHono().request("http://localhost/lifecycle");
    const bodyA = await responseA.json();
    expect(bodyA.initCount).toBe(1);
    expect(bodyA.path).toBe("/lifecycle");

    const responseB = await app.getHono().request("http://localhost/lifecycle");
    const bodyB = await responseB.json();
    expect(bodyB.initCount).toBe(1);
    expect(bodyB.path).toBe("/lifecycle");
  });

  it("throws a clear error on circular module imports", () => {
    const app = createApp();

    expect(() => app.registerModule(CircularModuleA)).toThrowError(
      "Circular module import detected: CircularModuleA -> CircularModuleB -> CircularModuleA",
    );
  });

  it("registers shared controllers only once across different modules", () => {
    const app = createApp();
    app.registerModule(RootSharedModule);

    const routes = ((app.getHono() as unknown as { routes?: Array<{ method: string; path: string }> })
      .routes ?? [])
      .filter((route) => route.method === "GET" && route.path === "/shared");

    expect(routes).toHaveLength(1);
  });

  it("reuses request-scoped providers within the same request context", () => {
    requestScopedInstanceCount = 0;
    const app = createApp();
    app.registerModule(ScopedProvidersModule);

    const contextA = { req: { path: "/a" } };
    const contextB = { req: { path: "/b" } };

    const a1 = app.getContainer().resolveWithContext(RequestScopedService, contextA);
    const a2 = app.getContainer().resolveWithContext(RequestScopedService, contextA);
    const b1 = app.getContainer().resolveWithContext(RequestScopedService, contextB);

    expect(a1.instanceId).toBe(a2.instanceId);
    expect(b1.instanceId).not.toBe(a1.instanceId);
  });

  it("creates transient providers on every resolution even in the same request context", () => {
    transientInstanceCount = 0;
    const app = createApp();
    app.registerModule(ScopedProvidersModule);

    const context = { req: { path: "/transient" } };
    const t1 = app.getContainer().resolveWithContext(TransientService, context);
    const t2 = app.getContainer().resolveWithContext(TransientService, context);

    expect(t1.instanceId).not.toBe(t2.instanceId);
  });

  it("isolates providers across application instances", () => {
    const appA = createApp();
    const appB = createApp();

    appA.registerModule(HealthModule);
    appB.registerModule(HealthModule);

    const serviceA = appA.getContainer().resolve(PingService);
    const serviceB = appB.getContainer().resolve(PingService);

    expect(serviceA).not.toBe(serviceB);
  });
});
