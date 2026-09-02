import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  Catch,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  Injectable,
  NotFoundException,
  TooManyRequestsException,
  UnauthorizedException,
  UseFilters,
  UseGuards,
  UseInterceptors,
  createTestingModule,
  type CanActivate,
  type ExceptionFilter,
  type ExecutionContext,
  type HonovaInterceptor,
} from "../src/index";

// Silence the observability access logs and the default exception logging so
// deliberate 4xx/5xx assertions do not clutter the test output.
const consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];

beforeAll(() => {
  consoleSpies.push(
    vi.spyOn(console, "info").mockImplementation(() => {}),
    vi.spyOn(console, "warn").mockImplementation(() => {}),
    vi.spyOn(console, "error").mockImplementation(() => {}),
    vi.spyOn(console, "debug").mockImplementation(() => {}),
  );
});

afterAll(() => {
  for (const spy of consoleSpies) {
    spy.mockRestore();
  }
});

// ---------------------------------------------------------------------------
// 1. Guard basics: false -> 403, thrown HttpException -> its own status
// ---------------------------------------------------------------------------

class DenyGuard implements CanActivate {
  canActivate(): boolean {
    return false;
  }
}

class ThrowUnauthorizedGuard implements CanActivate {
  canActivate(): boolean {
    throw new UnauthorizedException("Missing token");
  }
}

@Controller("/basic")
class BasicGuardController {
  @Get("/denied")
  @UseGuards(DenyGuard)
  denied(): { ok: boolean } {
    return { ok: true };
  }

  @Get("/unauthorized")
  @UseGuards(ThrowUnauthorizedGuard)
  unauthorized(): { ok: boolean } {
    return { ok: true };
  }
}

const basicGuardApp = createTestingModule({
  controllers: [BasicGuardController],
}).compile();

describe("guard basics", () => {
  it("maps a guard returning false to 403 with the forbidden envelope", async () => {
    const res = await basicGuardApp.request("/basic/denied");

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: "forbidden", message: "Forbidden" },
    });
  });

  it("maps a guard throwing UnauthorizedException to 401", async () => {
    const res = await basicGuardApp.request("/basic/unauthorized");

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: "unauthorized", message: "Missing token" },
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Guard order (global -> class -> method) and short-circuit on rejection
// ---------------------------------------------------------------------------

const guardLog: string[] = [];

function makeLogGuard(name: string, allow = true): CanActivate {
  return {
    canActivate(): boolean {
      guardLog.push(name);
      return allow;
    },
  };
}

let blockedHandlerRan = false;

@Controller("/order")
@UseGuards(makeLogGuard("class"))
class GuardOrderController {
  @Get("/ok")
  @UseGuards(makeLogGuard("method"))
  ok(): { ok: boolean } {
    guardLog.push("handler");
    return { ok: true };
  }
}

@Controller("/short-circuit")
@UseGuards(makeLogGuard("sc:class", false))
class ShortCircuitController {
  @Get("/blocked")
  @UseGuards(makeLogGuard("sc:method"))
  blocked(): { ok: boolean } {
    blockedHandlerRan = true;
    return { ok: true };
  }
}

const guardOrderApp = createTestingModule(
  { controllers: [GuardOrderController] },
  { guards: [makeLogGuard("global")] },
).compile();

const shortCircuitApp = createTestingModule(
  { controllers: [ShortCircuitController] },
  { guards: [makeLogGuard("sc:global")] },
).compile();

describe("guard order and short-circuit", () => {
  beforeEach(() => {
    guardLog.length = 0;
    blockedHandlerRan = false;
  });

  it("runs global guards before class guards before method guards", async () => {
    const res = await guardOrderApp.request("/order/ok");

    expect(res.status).toBe(200);
    expect(guardLog).toEqual(["global", "class", "method", "handler"]);
  });

  it("stops the guard chain at the first rejection", async () => {
    const res = await shortCircuitApp.request("/short-circuit/blocked");

    expect(res.status).toBe(403);
    expect(guardLog).toEqual(["sc:global", "sc:class"]);
    expect(guardLog).not.toContain("sc:method");
    expect(blockedHandlerRan).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Guards as DI classes (with a dependency) and as plain instances
// ---------------------------------------------------------------------------

@Injectable()
class AuditService {
  readonly events: string[] = [];

  record(event: string): void {
    this.events.push(event);
  }
}

@Injectable()
class AuditGuard implements CanActivate {
  constructor(private readonly auditService: AuditService) {}

  canActivate(ctx: ExecutionContext): boolean {
    this.auditService.record(`guard:${ctx.getContext().req.path}`);
    return true;
  }
}

const instanceGuardLog: string[] = [];
const instanceGuard: CanActivate = {
  canActivate(): boolean {
    instanceGuardLog.push("instance-guard");
    return true;
  },
};

@Controller("/di")
@UseGuards(AuditGuard)
class DiGuardController {
  @Get("/audited")
  @UseGuards(instanceGuard)
  audited(): { ok: boolean } {
    return { ok: true };
  }
}

const diGuardApp = createTestingModule({
  controllers: [DiGuardController],
  providers: [AuditService, AuditGuard],
}).compile();

describe("guards as DI classes and plain instances", () => {
  beforeEach(() => {
    instanceGuardLog.length = 0;
  });

  it("resolves a class guard through DI, injecting its dependency", async () => {
    const res = await diGuardApp.request("/di/audited");

    expect(res.status).toBe(200);

    const audit = await diGuardApp.resolve(AuditService);
    expect(audit.events).toContain("guard:/di/audited");
  });

  it("accepts a plain object instance as a guard", async () => {
    const res = await diGuardApp.request("/di/audited");

    expect(res.status).toBe(200);
    expect(instanceGuardLog).toEqual(["instance-guard"]);
  });
});

// ---------------------------------------------------------------------------
// 4. Interceptors: FILO onion, result mapping, short-circuit, exception rescue
// ---------------------------------------------------------------------------

const onionLog: string[] = [];

function makeMarkerInterceptor(name: string): HonovaInterceptor {
  return {
    async intercept(_ctx, next): Promise<unknown> {
      onionLog.push(`${name}:enter`);
      const result = await next();
      onionLog.push(`${name}:leave`);
      return result;
    },
  };
}

const mappingInterceptor: HonovaInterceptor = {
  async intercept(_ctx, next): Promise<unknown> {
    const result = await next();
    return { data: result };
  },
};

let cachedHandlerRan = false;
const shortCircuitInterceptor: HonovaInterceptor = {
  async intercept(): Promise<unknown> {
    return { cached: true };
  },
};

const rescueInterceptor: HonovaInterceptor = {
  async intercept(_ctx, next): Promise<unknown> {
    try {
      return await next();
    } catch {
      return { fallback: true };
    }
  },
};

@Controller("/intc")
class InterceptorController {
  @Get("/onion")
  @UseInterceptors(makeMarkerInterceptor("first"), makeMarkerInterceptor("second"))
  onion(): { ok: boolean } {
    onionLog.push("handler");
    return { ok: true };
  }

  @Get("/mapped")
  @UseInterceptors(mappingInterceptor)
  mapped(): { name: string } {
    return { name: "honova" };
  }

  @Get("/cached")
  @UseInterceptors(shortCircuitInterceptor)
  cached(): { ok: boolean } {
    cachedHandlerRan = true;
    return { ok: true };
  }

  @Get("/rescued")
  @UseInterceptors(rescueInterceptor)
  rescued(): never {
    throw new NotFoundException("gone");
  }
}

const interceptorApp = createTestingModule({
  controllers: [InterceptorController],
}).compile();

describe("interceptors", () => {
  beforeEach(() => {
    onionLog.length = 0;
    cachedHandlerRan = false;
  });

  it("wraps the handler as an onion where the first-listed interceptor is outermost", async () => {
    const res = await interceptorApp.request("/intc/onion");

    expect(res.status).toBe(200);
    expect(onionLog).toEqual([
      "first:enter",
      "second:enter",
      "handler",
      "second:leave",
      "first:leave",
    ]);
  });

  it("lets an interceptor reshape the handler result", async () => {
    const res = await interceptorApp.request("/intc/mapped");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { name: "honova" } });
  });

  it("short-circuits when an interceptor returns without calling next", async () => {
    const res = await interceptorApp.request("/intc/cached");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cached: true });
    expect(cachedHandlerRan).toBe(false);
  });

  it("lets an interceptor catch a handler exception and return a fallback", async () => {
    const res = await interceptorApp.request("/intc/rescued");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ fallback: true });
  });
});

// ---------------------------------------------------------------------------
// 5. Exception filters: matching, fall-through, undefined pass-through
// ---------------------------------------------------------------------------

class AlphaError extends Error {}
class BetaError extends Error {}
class GammaError extends Error {}
class DeltaError extends Error {}

const filterLog: string[] = [];

@Catch(AlphaError)
class AlphaMethodFilter implements ExceptionFilter {
  catch(): Response {
    filterLog.push("method-filter");
    return Response.json({ handledBy: "method-filter" }, { status: 418 });
  }
}

@Catch(DeltaError)
class DeltaPassFilter implements ExceptionFilter {
  catch(): undefined {
    filterLog.push("delta-pass");
    return undefined;
  }
}

@Catch(BetaError, DeltaError)
class ControllerLevelFilter implements ExceptionFilter {
  catch(): Response {
    filterLog.push("controller-filter");
    return Response.json({ handledBy: "controller-filter" }, { status: 422 });
  }
}

@Catch(GammaError)
class GlobalLevelFilter implements ExceptionFilter {
  catch(): Response {
    filterLog.push("global-filter");
    return Response.json({ handledBy: "global-filter" }, { status: 502 });
  }
}

@Controller("/filters")
@UseFilters(new ControllerLevelFilter())
class FilterController {
  @Get("/alpha")
  @UseFilters(AlphaMethodFilter)
  alpha(): never {
    throw new AlphaError("alpha failed");
  }

  @Get("/beta")
  @UseFilters(AlphaMethodFilter)
  beta(): never {
    throw new BetaError("beta failed");
  }

  @Get("/gamma")
  @UseFilters(AlphaMethodFilter)
  gamma(): never {
    throw new GammaError("gamma failed");
  }

  @Get("/unmatched")
  @UseFilters(AlphaMethodFilter)
  unmatched(): never {
    throw new ConflictException("name taken");
  }

  @Get("/pass")
  @UseFilters(DeltaPassFilter)
  pass(): never {
    throw new DeltaError("delta failed");
  }
}

const filterApp = createTestingModule(
  { controllers: [FilterController] },
  { filters: [new GlobalLevelFilter()] },
).compile();

describe("exception filters", () => {
  beforeEach(() => {
    filterLog.length = 0;
  });

  it("handles a matching exception with the method-level @Catch filter", async () => {
    const res = await filterApp.request("/filters/alpha");

    expect(res.status).toBe(418);
    expect(await res.json()).toEqual({ handledBy: "method-filter" });
    expect(filterLog).toEqual(["method-filter"]);
  });

  it("falls through an unmatched method filter to the controller-level filter", async () => {
    const res = await filterApp.request("/filters/beta");

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ handledBy: "controller-filter" });
    expect(filterLog).toEqual(["controller-filter"]);
  });

  it("falls through method and controller filters to the global filter", async () => {
    const res = await filterApp.request("/filters/gamma");

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ handledBy: "global-filter" });
    expect(filterLog).toEqual(["global-filter"]);
  });

  it("falls back to the default mapping when no filter matches", async () => {
    const res = await filterApp.request("/filters/unmatched");

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: { code: "conflict", message: "name taken" },
    });
    expect(filterLog).toEqual([]);
  });

  it("passes the exception to the next filter when a filter returns undefined", async () => {
    const res = await filterApp.request("/filters/pass");

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ handledBy: "controller-filter" });
    expect(filterLog).toEqual(["delta-pass", "controller-filter"]);
  });
});

// ---------------------------------------------------------------------------
// 6. Default exception mapping: HttpException subclasses and unknown errors
// ---------------------------------------------------------------------------

@Controller("/errors")
class ErrorMappingController {
  @Get("/not-found")
  notFound(): never {
    throw new NotFoundException();
  }

  @Get("/conflict")
  conflict(): never {
    throw new ConflictException();
  }

  @Get("/too-many")
  tooMany(): never {
    throw new TooManyRequestsException();
  }

  @Get("/boom")
  boom(): never {
    throw new Error("kaboom: secret internals");
  }
}

const errorApp = createTestingModule({
  controllers: [ErrorMappingController],
}).compile();

describe("default exception mapping", () => {
  it("maps NotFoundException to 404 not_found", async () => {
    const res = await errorApp.request("/errors/not-found");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "not_found", message: "Not found" },
    });
  });

  it("maps ConflictException to 409 conflict", async () => {
    const res = await errorApp.request("/errors/conflict");

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: { code: "conflict", message: "Conflict" },
    });
  });

  it("maps TooManyRequestsException to 429 too_many_requests", async () => {
    const res = await errorApp.request("/errors/too-many");

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: { code: "too_many_requests", message: "Too many requests" },
    });
  });

  it("maps an unknown Error to the 500 internal_error envelope without leaking the message", async () => {
    const res = await errorApp.request("/errors/boom");

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: "internal_error", message: "Internal server error" },
    });
  });
});

describe("typed exception subclasses", () => {
  it("keeps the declared relationship to Error and HttpException", () => {
    const exception = new ForbiddenException("nope");

    // Assignability here is the point: an inferred anonymous base class emits a
    // structural type in the .d.ts and silently breaks both of these for
    // consumers.
    const asError: Error = exception;
    const asHttpException: HttpException = exception;

    expect(asError).toBeInstanceOf(Error);
    expect(asHttpException.status).toBe(403);
    expect(asHttpException.code).toBe("forbidden");
    expect(asError.message).toBe("nope");
  });

  it("keeps its default message and code", () => {
    const exception = new NotFoundException();

    expect(exception.status).toBe(404);
    expect(exception.code).toBe("not_found");
    expect(exception.message).toBe("Not found");
  });
});
