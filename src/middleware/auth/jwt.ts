import { verify } from "hono/jwt";
import type { SignatureAlgorithm } from "hono/utils/jwt/jwa";

import type { CanActivate } from "../../core/pipeline/guards.js";
import type { ExecutionContext } from "../../core/execution-context.js";
import {
  ForbiddenException,
  InternalServerErrorException,
  UnauthorizedException,
} from "../../core/exceptions/http-exception.js";
import { createDecorator, reflector } from "../../core/reflector.js";

export interface JwtGuardOptions<Env extends Record<string, unknown> = Record<string, unknown>> {
  /** Static secret. Prefer secretFromEnv on Workers (secrets are bindings). */
  secret?: string;
  /** Name of the env binding holding the secret (Wrangler secret). */
  secretFromEnv?: Extract<keyof Env, string> | string;
  header?: string;
  scheme?: string;
  algorithm?: SignatureAlgorithm;
  /** Maps the verified payload to the principal stored at c.get("auth"). */
  principal?: (payload: Record<string, unknown>) => unknown;
  /**
   * Reject tokens without an exp claim (default true): a token that cannot
   * expire is a standing credential, not a session.
   */
  requireExp?: boolean;
  /** When set, the token's iss claim must equal this value. */
  issuer?: string;
  /** When set, the token's aud (string or array) must include this value. */
  audience?: string;
}

/**
 * JWT verification as a guard, on hono's built-in WebCrypto JWT utilities —
 * no extra dependency. Verified payload (or its mapped principal) lands in
 * c.get("auth"), same slot the bearer/API-key middleware use.
 *
 *   @UseGuards(createJwtGuard({ secretFromEnv: "JWT_SIGNING_KEY" }))
 */
export function createJwtGuard<Env extends Record<string, unknown>>(
  options: JwtGuardOptions<Env>,
): CanActivate {
  const headerName = (options.header ?? "authorization").toLowerCase();
  const scheme = options.scheme ?? "Bearer";

  return {
    async canActivate(ctx: ExecutionContext): Promise<boolean> {
      const c = ctx.getContext();

      const secret =
        options.secret ??
        (options.secretFromEnv
          ? (ctx.env as Record<string, unknown>)[options.secretFromEnv]
          : undefined);

      if (typeof secret !== "string" || secret.length === 0) {
        // Fail closed: a missing secret is a deployment error, not an
        // authentication failure the caller can fix.
        throw new InternalServerErrorException("JWT secret is not configured");
      }

      const rawHeader = c.req.header(headerName);
      const token = rawHeader?.startsWith(`${scheme} `)
        ? rawHeader.slice(scheme.length + 1).trim()
        : undefined;

      if (!token) {
        throw new UnauthorizedException("Missing bearer token");
      }

      let payload: Record<string, unknown>;
      try {
        payload = (await verify(token, secret, options.algorithm ?? "HS256")) as Record<
          string,
          unknown
        >;
      } catch {
        throw new UnauthorizedException("Invalid or expired token");
      }

      if ((options.requireExp ?? true) && typeof payload.exp !== "number") {
        throw new UnauthorizedException("Token has no expiration");
      }

      if (options.issuer !== undefined && payload.iss !== options.issuer) {
        throw new UnauthorizedException("Invalid token issuer");
      }

      if (options.audience !== undefined) {
        const aud = payload.aud;
        const audiences = Array.isArray(aud) ? aud : [aud];
        if (!audiences.includes(options.audience)) {
          throw new UnauthorizedException("Invalid token audience");
        }
      }

      c.set("auth", options.principal ? options.principal(payload) : payload);
      return true;
    },
  };
}

/** Role requirements read by RolesGuard: @Roles(["admin"]). */
export const Roles = createDecorator<string[]>("honova:roles");

/**
 * Authorizes against roles on the authenticated principal (c.get("auth")).
 * Handler-level @Roles overrides controller-level; no metadata means open.
 */
export class RolesGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const required = reflector.getAllAndOverride(Roles, [ctx.getHandler(), ctx.getClass()]);

    if (!required || required.length === 0) {
      return true;
    }

    const principal = ctx.getContext().get("auth") as { roles?: unknown } | undefined;
    if (!principal) {
      throw new UnauthorizedException("Authentication required");
    }

    const roles = Array.isArray(principal.roles) ? (principal.roles as string[]) : [];
    if (!required.some((role) => roles.includes(role))) {
      throw new ForbiddenException("Insufficient role");
    }

    return true;
  }
}
