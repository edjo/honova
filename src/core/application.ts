import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";

import { Container } from "./container/container";
import { createDbManagerMiddleware, type DbManagerMiddlewareOptions } from "../database/middleware";
import { Router } from "./router/router";
import type { Constructor } from "./types";
import { getInjectableMetadata, getModuleMetadata } from "./metadata";

export interface SecurityOptions {
  cors?: Parameters<typeof cors>[0];
  secureHeaders?: boolean | Parameters<typeof secureHeaders>[0];
}

export interface ObservabilityOptions {
  requestIdHeader?: string;
  enableAccessLogs?: boolean;
  logLevel?: "debug" | "info" | "warn" | "error";
  redactHeaders?: string[];
}

export interface ApplicationOptions<Env extends Record<string, unknown>> {
  basePath?: string;
  globalMiddlewares?: MiddlewareHandler[];
  database?: DbManagerMiddlewareOptions<Env>;
  security?: SecurityOptions;
  observability?: ObservabilityOptions;
  di?: { strict?: boolean };
}

const defaultRedactHeaders = ["authorization", "cookie", "set-cookie", "x-api-key"];

function createObservabilityMiddleware<Env extends Record<string, unknown>>(
  options: ObservabilityOptions | undefined,
): MiddlewareHandler<{ Bindings: Env }> {
  const requestIdHeader = options?.requestIdHeader ?? "x-request-id";
  const accessLogs = options?.enableAccessLogs ?? true;
  const level = options?.logLevel ?? "info";
  const redactHeaders = options?.redactHeaders ?? defaultRedactHeaders;

  return async (c, next) => {
    const requestId = c.req.header(requestIdHeader) ?? crypto.randomUUID();
    const start = Date.now();

    await next();

    c.res.headers.set(requestIdHeader, requestId);

    if (!accessLogs) {
      return;
    }

    const status = c.res.status;
    const line = `[${requestId}] ${c.req.method} ${c.req.path} -> ${status} (${Date.now() - start}ms)`;
    if (status >= 500) {
      console.error(line);
    } else if (status >= 400) {
      console.warn(line);
    } else if (level !== "error" && level !== "warn") {
      console.info(line);
    }

    if (level === "debug") {
      const headers: Record<string, string> = {};
      const redacted = new Set(redactHeaders.map((h) => h.toLowerCase()));
      c.req.raw.headers.forEach((value, key) => {
        headers[key] = redacted.has(key.toLowerCase()) ? "[REDACTED]" : value;
      });
      console.debug(`[${requestId}] request_headers`, headers);
    }
  };
}

export class Application<Env extends Record<string, unknown> = Record<string, unknown>> {
  private app: Hono<{ Bindings: Env }>;
  private readonly container: Container;
  private readonly router: Router<Env>;
  private readonly registeredProviders = new Set<Constructor>();
  private readonly registeredControllers = new Set<Constructor>();
  private readonly registeredModules = new Set<Constructor>();
  private readonly moduleResolutionStack: Constructor[] = [];

  constructor(options: ApplicationOptions<Env> = {}) {
    this.app = new Hono<{ Bindings: Env }>({ strict: false });
    this.container = new Container();
    this.container.configure({ strict: options.di?.strict ?? true });

    if (options.basePath) {
      this.app = this.app.basePath(options.basePath);
    }

    this.app.use("*", createObservabilityMiddleware(options.observability));
    this.app.use("*", cors(options.security?.cors));

    if (options.security?.secureHeaders) {
      const settings =
        typeof options.security.secureHeaders === "boolean"
          ? undefined
          : options.security.secureHeaders;
      this.app.use("*", secureHeaders(settings));
    }

    if (options.database) {
      this.app.use("*", createDbManagerMiddleware(options.database));
    }

    for (const middleware of options.globalMiddlewares ?? []) {
      this.app.use("*", middleware);
    }

    this.app.notFound((c) =>
      c.json({ error: { code: "not_found", message: "Route not found" } }, 404),
    );
    this.app.onError((err, c) => {
      console.error(err);
      return c.json(
        { error: { code: "internal_error", message: "Internal server error" } },
        500,
      );
    });

    this.router = new Router(this.app, this.container);
  }

  registerModule(moduleClass: Constructor): this {
    if (this.registeredModules.has(moduleClass)) {
      return this;
    }

    const cycleStartIndex = this.moduleResolutionStack.indexOf(moduleClass);
    if (cycleStartIndex >= 0) {
      const cycle = [...this.moduleResolutionStack.slice(cycleStartIndex), moduleClass]
        .map((moduleToken) => moduleToken.name)
        .join(" -> ");

      throw new Error(`Circular module import detected: ${cycle}`);
    }

    this.moduleResolutionStack.push(moduleClass);

    try {
      const metadata = getModuleMetadata(moduleClass);

      if (!metadata) {
        throw new Error(`Class ${moduleClass.name} is not decorated with @Module()`);
      }

      for (const imported of metadata.imports ?? []) {
        this.registerModule(imported);
      }

      for (const provider of metadata.providers ?? []) {
        const injectableMetadata = getInjectableMetadata(provider);
        if (!injectableMetadata) {
          throw new Error(
            `Provider ${provider.name} in ${moduleClass.name} must be decorated with @Injectable().`,
          );
        }

        if (!this.registeredProviders.has(provider)) {
          this.container.register(provider);
          this.registeredProviders.add(provider);
        }
      }

      for (const controller of metadata.controllers ?? []) {
        if (this.registeredControllers.has(controller)) {
          continue;
        }

        this.container.register(controller);
        this.router.registerController(controller);
        this.registeredControllers.add(controller);
      }

      this.registeredModules.add(moduleClass);

      return this;
    } finally {
      this.moduleResolutionStack.pop();
    }
  }

  use(middleware: MiddlewareHandler): this {
    this.app.use("*", middleware);
    return this;
  }

  getContainer(): Container {
    return this.container;
  }

  getHono(): Hono<{ Bindings: Env }> {
    return this.app;
  }

  fetch = (request: Request, env: Env, ctx: any): Response | Promise<Response> => {
    return this.app.fetch(request, env, ctx);
  };
}

export function createApp<Env extends Record<string, unknown> = Record<string, unknown>>(
  options: ApplicationOptions<Env> = {},
): Application<Env> {
  return new Application(options);
}
