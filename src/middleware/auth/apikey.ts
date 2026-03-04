import type { MiddlewareHandler } from "hono";

import { UseMiddleware } from "../../core/decorators/middleware";

export interface ApiKeyPrincipal {
  id?: string;
  [key: string]: unknown;
}

export interface UseApiKeyOptions<
  Env extends Record<string, unknown> = Record<string, unknown>,
  Principal extends ApiKeyPrincipal = ApiKeyPrincipal,
> {
  header?: string;
  verify: (apiKey: string, context: {
    env: Env;
    request: Request;
  }) => Promise<Principal | null> | Principal | null;
  onError?: (reason: "missing_api_key" | "invalid_api_key", c: any) => Response;
}

function defaultAuthError(reason: "missing_api_key" | "invalid_api_key"): Response {
  const message =
    reason === "missing_api_key"
      ? "Unauthorized: Missing API key"
      : "Unauthorized: Invalid API key";

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

function createApiKeyMiddleware<
  Env extends Record<string, unknown>,
  Principal extends ApiKeyPrincipal,
>(options: UseApiKeyOptions<Env, Principal>): MiddlewareHandler {
  const headerName = (options.header ?? "x-api-key").toLowerCase();

  return async (c, next) => {
    const apiKey = c.req.header(headerName);

    if (!apiKey) {
      return options.onError?.("missing_api_key", c) ?? defaultAuthError("missing_api_key");
    }

    const principal = await options.verify(apiKey, {
      env: c.env as Env,
      request: c.req.raw,
    });

    if (!principal) {
      return options.onError?.("invalid_api_key", c) ?? defaultAuthError("invalid_api_key");
    }

    c.set("auth", principal);
    await next();
  };
}

export function UseApiKey<
  Env extends Record<string, unknown>,
  Principal extends ApiKeyPrincipal = ApiKeyPrincipal,
>(options: UseApiKeyOptions<Env, Principal>) {
  return UseMiddleware(createApiKeyMiddleware(options));
}

export function ApiKeyAuth<
  Env extends Record<string, unknown>,
  Principal extends ApiKeyPrincipal = ApiKeyPrincipal,
>(options: UseApiKeyOptions<Env, Principal>): MiddlewareHandler {
  return createApiKeyMiddleware(options);
}
