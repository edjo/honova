import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  Controller,
  Get,
  Post,
  Public,
  UnauthorizedException,
  createTestingModule,
  isPublicHandler,
  type CanActivate,
  type ExecutionContext,
} from "../src/index";

/**
 * `@Public()` marks intent. Each guard decides what to do with it.
 *
 * The decorator deliberately does not make the router skip guards, because
 * only a guard knows whether "public" applies to it: a session guard should
 * stand down on a login form, and a CSRF guard should not. So these tests
 * cover two guards reading the same marker and reaching opposite conclusions,
 * which is the whole design and the thing a future refactor could quietly
 * break by moving the check into the router.
 */
const consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];

beforeAll(() => {
  consoleSpies.push(
    vi.spyOn(console, "info").mockImplementation(() => {}),
    vi.spyOn(console, "warn").mockImplementation(() => {}),
    vi.spyOn(console, "error").mockImplementation(() => {}),
  );
});

afterAll(() => {
  for (const spy of consoleSpies) spy.mockRestore();
});

/** Stands down on a public handler, the way a session guard would. */
const session: CanActivate = {
  canActivate(ctx: ExecutionContext): boolean {
    if (isPublicHandler(ctx.getHandler())) return true;

    throw new UnauthorizedException("Sign in first");
  },
};

/** Runs regardless, the way a CSRF guard would on an open form POST. */
const csrfLog: string[] = [];
const csrf: CanActivate = {
  canActivate(ctx: ExecutionContext): boolean {
    csrfLog.push(ctx.getContext().req.path);

    return true;
  },
};

@Controller("/")
class Routes {
  @Get("/private")
  private_() {
    return { ok: "private" };
  }

  @Get("/health")
  @Public()
  health() {
    return { ok: "health" };
  }

  /*
    Below the method decorator on purpose. Decorators evaluate bottom-up, and a
    marker that only worked when written above the route would be a trap the
    compiler cannot see.
  */
  @Post("/login")
  @Public()
  login() {
    return { ok: "login" };
  }
}

const app = createTestingModule(
  { controllers: [Routes] },
  { guards: [csrf, session] },
).compile();

describe("@Public()", () => {
  it("lets a guard that honours it through", async () => {
    const res = await app.request("/health");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: "health" });
  });

  it("leaves an unmarked handler guarded", async () => {
    const res = await app.request("/private");

    expect(res.status).toBe(401);
  });

  it("works below the HTTP method decorator", async () => {
    const res = await app.request("/login", { method: "POST" });

    expect(res.status).toBe(200);
  });

  /*
    The point of marking rather than skipping.

     is registered FIRST so it runs before  short-circuits, which
    is also the realistic order: a CSRF check belongs before authentication.
    Had the router skipped the chain on a public handler, this list would be
    missing the two open paths and a CSRF guard would have quietly stopped
    protecting exactly the forms that need it.

    Self-contained rather than reading a log the earlier tests filled, so it
    cannot pass on another test's side effects.
  */
  it("still runs guards that do not honour it", async () => {
    csrfLog.length = 0;

    await app.request("/health");
    await app.request("/private");
    await app.request("/login", { method: "POST" });

    expect(csrfLog).toEqual(["/health", "/private", "/login"]);
  });
});

describe("isPublicHandler", () => {
  it("is keyed on the function, so a copy carries the mark and a stranger does not", () => {
    const marked = new Routes().health;
    const plain = new Routes().private_;

    expect(isPublicHandler(marked)).toBe(true);
    expect(isPublicHandler(plain)).toBe(false);
  });

  it("answers false for anything that is not a function", () => {
    for (const value of [undefined, null, "health", 42, {}, []]) {
      expect(isPublicHandler(value)).toBe(false);
    }
  });
});
