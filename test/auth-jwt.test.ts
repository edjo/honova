import { describe, expect, it } from "vitest";
import type { Context } from "hono";
import { sign } from "hono/jwt";

import {
  Controller,
  Get,
  Module,
  Roles,
  RolesGuard,
  UseGuards,
  createApp,
  createJwtGuard,
  createTestingModule,
} from "../src/index";

const SECRET = "test-jwt-secret";
const WRONG_SECRET = "totally-different-secret";

const nowSeconds = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------
// Controllers under test
// ---------------------------------------------------------------------------

@Controller("/jwt")
class JwtController {
  @Get("/claims")
  @UseGuards(createJwtGuard({ secret: SECRET }))
  claims(c: Context): Response {
    return Response.json({ auth: c.get("auth") });
  }

  @Get("/principal")
  @UseGuards(
    createJwtGuard({
      secret: SECRET,
      principal: (p) => ({ id: p.sub, roles: p.roles }),
    }),
  )
  principal(c: Context): Response {
    return Response.json({ auth: c.get("auth") });
  }
}

@Controller("/env-jwt")
class EnvJwtController {
  @Get("/")
  @UseGuards(createJwtGuard({ secretFromEnv: "JWT_SECRET" }))
  handle(c: Context): Response {
    return Response.json({ auth: c.get("auth") });
  }
}

@Controller("/admin")
@UseGuards(
  createJwtGuard({
    secret: SECRET,
    principal: (p) => ({ id: p.sub, roles: p.roles }),
  }),
  RolesGuard,
)
class AdminController {
  @Get("/panel")
  @Roles(["admin"])
  panel(): Response {
    return Response.json({ area: "panel" });
  }

  @Get("/open")
  open(): Response {
    // No @Roles metadata: any authenticated principal passes.
    return Response.json({ area: "open" });
  }
}

@Controller("/override")
@Roles(["admin"])
@UseGuards(
  createJwtGuard({
    secret: SECRET,
    principal: (p) => ({ id: p.sub, roles: p.roles }),
  }),
  RolesGuard,
)
class OverrideController {
  @Get("/inherited")
  inherited(): Response {
    // Uses the controller-level ["admin"] requirement.
    return Response.json({ area: "inherited" });
  }

  @Get("/editor")
  @Roles(["editor"])
  editor(): Response {
    // Handler-level @Roles overrides the controller-level one.
    return Response.json({ area: "editor" });
  }
}

@Controller("/roles-only")
@UseGuards(RolesGuard)
class RolesOnlyController {
  @Get("/")
  @Roles(["admin"])
  handle(): Response {
    // RolesGuard runs without any auth guard populating c.get("auth").
    return Response.json({ ok: true });
  }
}

@Module({
  controllers: [
    JwtController,
    EnvJwtController,
    AdminController,
    OverrideController,
    RolesOnlyController,
  ],
})
class AuthTestModule {}

function buildTestApp() {
  return createTestingModule({ imports: [AuthTestModule] }).compile();
}

function bearer(token: string): { headers: Record<string, string> } {
  return { headers: { authorization: `Bearer ${token}` } };
}

// ---------------------------------------------------------------------------
// 1. createJwtGuard with a static secret
// ---------------------------------------------------------------------------

describe("createJwtGuard with static secret", () => {
  it("accepts a valid token and exposes the payload claims at c.get('auth')", async () => {
    const app = buildTestApp();
    const token = await sign(
      { sub: "user-1", name: "Ada", exp: nowSeconds() + 3600 },
      SECRET,
    );

    const response = await app.request("/jwt/claims", bearer(token));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.auth.sub).toBe("user-1");
    expect(body.auth.name).toBe("Ada");
  });

  it("rejects a request with no Authorization header with 401 'Missing bearer token'", async () => {
    const app = buildTestApp();

    const response = await app.request("/jwt/claims");
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("unauthorized");
    expect(body.error.message).toBe("Missing bearer token");
  });

  it("rejects a malformed scheme (e.g. 'Token abc') with 401", async () => {
    const app = buildTestApp();
    const token = await sign({ sub: "user-1", exp: nowSeconds() + 3600 }, SECRET);

    const response = await app.request("/jwt/claims", {
      headers: { authorization: `Token ${token}` },
    });
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("unauthorized");
    expect(body.error.message).toBe("Missing bearer token");
  });

  it("rejects a tampered signature with 401 'Invalid or expired token'", async () => {
    const app = buildTestApp();
    // Signed with the wrong secret: header/payload parse fine, signature fails.
    const tampered = await sign({ sub: "user-1", exp: nowSeconds() + 3600 }, WRONG_SECRET);

    const response = await app.request("/jwt/claims", bearer(tampered));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("unauthorized");
    expect(body.error.message).toBe("Invalid or expired token");
  });

  it("rejects an expired token (exp in the past) with 401", async () => {
    const app = buildTestApp();
    const expired = await sign({ sub: "user-1", exp: nowSeconds() - 3600 }, SECRET);

    const response = await app.request("/jwt/claims", bearer(expired));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("unauthorized");
    expect(body.error.message).toBe("Invalid or expired token");
  });
});

// ---------------------------------------------------------------------------
// 2. secretFromEnv (Workers env bindings)
// ---------------------------------------------------------------------------

describe("createJwtGuard with secretFromEnv", () => {
  const workersCtx = {
    waitUntil(): void {},
    passThroughOnException(): void {},
  };

  it("reads the secret from the env bindings passed to app.fetch", async () => {
    const app = createApp();
    app.registerModule(AuthTestModule);
    const token = await sign({ sub: "env-user", exp: nowSeconds() + 3600 }, SECRET);

    const response = await app.fetch(
      new Request("http://localhost/env-jwt", bearer(token)),
      { JWT_SECRET: SECRET },
      workersCtx,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.auth.sub).toBe("env-user");
  });

  it("fails closed with 500 internal_error when the binding is missing", async () => {
    const app = createApp();
    app.registerModule(AuthTestModule);
    const token = await sign({ sub: "env-user", exp: nowSeconds() + 3600 }, SECRET);

    const response = await app.fetch(
      new Request("http://localhost/env-jwt", bearer(token)),
      {},
      workersCtx,
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("internal_error");
    // 5xx bodies are opaque to clients since 0.1.0; the real reason is logged.
    expect(body.error.message).toBe("Internal server error");
  });
});

// ---------------------------------------------------------------------------
// 3. principal mapper
// ---------------------------------------------------------------------------

describe("principal mapper", () => {
  it("stores the mapped principal at c.get('auth') instead of the raw payload", async () => {
    const app = buildTestApp();
    const token = await sign(
      { sub: "user-42", roles: ["admin", "editor"], extra: "dropped", exp: nowSeconds() + 3600 },
      SECRET,
    );

    const response = await app.request("/jwt/principal", bearer(token));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.auth).toEqual({ id: "user-42", roles: ["admin", "editor"] });
    expect(body.auth.extra).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. @Roles + RolesGuard
// ---------------------------------------------------------------------------

describe("@Roles and RolesGuard", () => {
  it("allows a principal holding a required role", async () => {
    const app = buildTestApp();
    const token = await sign({ sub: "user-1", roles: ["admin"], exp: nowSeconds() + 3600 }, SECRET);

    const response = await app.request("/admin/panel", bearer(token));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.area).toBe("panel");
  });

  it("rejects a principal without the required role with 403 forbidden", async () => {
    const app = buildTestApp();
    const token = await sign({ sub: "user-2", roles: ["user"], exp: nowSeconds() + 3600 }, SECRET);

    const response = await app.request("/admin/panel", bearer(token));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("forbidden");
  });

  it("rejects with 401 when no auth principal is present at all", async () => {
    const app = buildTestApp();

    // /roles-only has RolesGuard + @Roles but no JWT guard, so c.get("auth")
    // is never populated; RolesGuard must demand authentication.
    const response = await app.request("/roles-only");
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("unauthorized");
  });

  it("lets any authenticated principal through a route without @Roles metadata", async () => {
    const app = buildTestApp();
    const token = await sign({ sub: "user-3", roles: ["user"], exp: nowSeconds() + 3600 }, SECRET);

    const response = await app.request("/admin/open", bearer(token));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.area).toBe("open");
  });

  it("handler-level @Roles overrides controller-level @Roles", async () => {
    const app = buildTestApp();
    const editorToken = await sign({ sub: "e-1", roles: ["editor"], exp: nowSeconds() + 3600 }, SECRET);
    const adminToken = await sign({ sub: "a-1", roles: ["admin"], exp: nowSeconds() + 3600 }, SECRET);

    // /override/editor requires ["editor"] (handler-level wins over ["admin"]).
    const editorOnEditor = await app.request("/override/editor", bearer(editorToken));
    expect(editorOnEditor.status).toBe(200);
    expect((await editorOnEditor.json()).area).toBe("editor");

    // The controller-level ["admin"] no longer applies to /override/editor.
    const adminOnEditor = await app.request("/override/editor", bearer(adminToken));
    expect(adminOnEditor.status).toBe(403);
    expect((await adminOnEditor.json()).error.code).toBe("forbidden");

    // Routes without handler-level @Roles still inherit the controller-level one.
    const adminOnInherited = await app.request("/override/inherited", bearer(adminToken));
    expect(adminOnInherited.status).toBe(200);
    expect((await adminOnInherited.json()).area).toBe("inherited");

    const editorOnInherited = await app.request("/override/inherited", bearer(editorToken));
    expect(editorOnInherited.status).toBe(403);
  });
});


// ---------------------------------------------------------------------------
// 6. Claim requirements (0.1.0 security hardening)
// ---------------------------------------------------------------------------

@Controller("/claims-required")
class ClaimsRequiredController {
  @Get("/default")
  @UseGuards(createJwtGuard({ secret: SECRET }))
  requireExpDefault(c: Context): Response {
    return Response.json({ auth: c.get("auth") });
  }

  @Get("/optional-exp")
  @UseGuards(createJwtGuard({ secret: SECRET, requireExp: false }))
  optionalExp(c: Context): Response {
    return Response.json({ auth: c.get("auth") });
  }

  @Get("/bound")
  @UseGuards(createJwtGuard({ secret: SECRET, issuer: "b2co", audience: "api" }))
  bound(c: Context): Response {
    return Response.json({ auth: c.get("auth") });
  }
}

describe("claim requirements (0.1.0 security hardening)", () => {
  const claimsApp = () =>
    createTestingModule({ controllers: [ClaimsRequiredController] }).compile();

  it("rejects a token without exp by default", async () => {
    const token = await sign({ sub: "no-exp" }, SECRET);
    const response = await claimsApp().request("/claims-required/default", bearer(token));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.message).toBe("Token has no expiration");
  });

  it("accepts a token without exp when requireExp is false", async () => {
    const token = await sign({ sub: "no-exp" }, SECRET);
    const response = await claimsApp().request("/claims-required/optional-exp", bearer(token));

    expect(response.status).toBe(200);
  });

  it("binds issuer and audience when configured", async () => {
    const good = await sign(
      { sub: "u", iss: "b2co", aud: ["api", "dash"], exp: nowSeconds() + 3600 },
      SECRET,
    );
    expect((await claimsApp().request("/claims-required/bound", bearer(good))).status).toBe(200);

    const wrongIss = await sign(
      { sub: "u", iss: "other", aud: "api", exp: nowSeconds() + 3600 },
      SECRET,
    );
    expect((await claimsApp().request("/claims-required/bound", bearer(wrongIss))).status).toBe(401);

    const wrongAud = await sign(
      { sub: "u", iss: "b2co", aud: "mobile", exp: nowSeconds() + 3600 },
      SECRET,
    );
    expect((await claimsApp().request("/claims-required/bound", bearer(wrongAud))).status).toBe(401);
  });
});
