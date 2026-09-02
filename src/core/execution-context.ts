import type { Context } from "hono";

import type { Constructor } from "./types";

/**
 * The argument every guard, interceptor, and exception filter receives.
 *
 * HTTP-only by design: honova targets Cloudflare Workers, so instead of Nest's
 * multi-transport switchToHttp/Rpc/Ws this exposes the Hono context plus the
 * Workers-native bits (env bindings, ExecutionContext with waitUntil).
 */
export class ExecutionContext<
  Env extends Record<string, unknown> = Record<string, unknown>,
> {
  constructor(
    private readonly honoContext: Context,
    private readonly controllerClass: Constructor | undefined,
    private readonly handlerRef: Function | undefined,
    private readonly handlerName?: string | symbol,
  ) {}

  /** The controller class the matched route belongs to. */
  getClass(): Constructor | undefined {
    return this.controllerClass;
  }

  /** The route handler function (the decorated method). */
  getHandler(): Function | undefined {
    return this.handlerRef;
  }

  getHandlerName(): string | symbol | undefined {
    return this.handlerName;
  }

  /** The underlying Hono context. */
  getContext(): Context {
    return this.honoContext;
  }

  get env(): Env {
    return this.honoContext.env as Env;
  }

  /** Cloudflare's ExecutionContext (waitUntil/passThroughOnException) when present. */
  get executionCtx(): { waitUntil(promise: Promise<unknown>): void } | undefined {
    try {
      return this.honoContext.executionCtx as never;
    } catch {
      return undefined;
    }
  }

  get request(): Request {
    return this.honoContext.req.raw;
  }
}
