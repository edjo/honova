import type { MiddlewareHandler } from "hono";

import { UseMiddleware } from "../../core/decorators/middleware";

export interface BearerAuthPrincipal {
  id?: string;
  [key: string]: unknown;
}

export interface UseBearerAuthOptions<
  Env extends Record<string, unknown> = Record<string, unknown>,
  Principal extends BearerAuthPrincipal = BearerAuthPrincipal,
> {
  header?: string;
  scheme?: string;
  verify: (token: string, context: {
    env: Env;
    request: Request;
  }) => Promise<Principal | null> | Principal | null;
  onError?: (reason: "missing_token" | "invalid_token", c: any) => Response;
}

function defaultAuthError(reason: "missing_token" | "invalid_token"): Response {
  const message =
    reason === "missing_token"
      ? "Unauthorized: Missing bearer token"
      : "Unauthorized: Invalid bearer token";

  return Response.json(
    {
      error: {
        code: "unauthorized",
        message,
      },
    },
    { status: 401 },
  );
}

function createBearerAuthMiddleware<
  Env extends Record<string, unknown>,
  Principal extends BearerAuthPrincipal,
>(options: UseBearerAuthOptions<Env, Principal>): MiddlewareHandler {
  const headerName = (options.header ?? "authorization").toLowerCase();
  const scheme = options.scheme ?? "Bearer";

  return async (c, next) => {
    const rawHeader = c.req.header(headerName);
    const token = rawHeader?.startsWith(`${scheme} `)
      ? rawHeader.slice(`${scheme} `.length).trim()
      : undefined;

    if (!token) {
      return options.onError?.("missing_token", c) ?? defaultAuthError("missing_token");
    }

    const principal = await options.verify(token, {
      env: c.env as Env,
      request: c.req.raw,
    });

    if (!principal) {
      return options.onError?.("invalid_token", c) ?? defaultAuthError("invalid_token");
    }

    c.set("auth", principal);
    await next();
  };
}

export function UseBearerAuth<
  Env extends Record<string, unknown>,
  Principal extends BearerAuthPrincipal = BearerAuthPrincipal,
>(options: UseBearerAuthOptions<Env, Principal>) {
  return UseMiddleware(createBearerAuthMiddleware(options));
}

export function BearerAuth<
  Env extends Record<string, unknown>,
  Principal extends BearerAuthPrincipal = BearerAuthPrincipal,
>(options: UseBearerAuthOptions<Env, Principal>): MiddlewareHandler {
  return createBearerAuthMiddleware(options);
}
