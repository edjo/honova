import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { methodNotAllowed } from "hono/method-not-allowed";

import { Container } from "./container/container.js";
import { createDbManagerMiddleware, type DbManagerMiddlewareOptions } from "../database/middleware.js";
import { Router, type GlobalPipeline } from "./router/router.js";
import type { Constructor, ProviderDefinition, Token } from "./types.js";
import { getInjectableMetadata, getModuleMetadata } from "./metadata.js";
import type { GuardRef } from "./pipeline/guards.js";
import type { InterceptorRef } from "./pipeline/interceptors.js";
import type { FilterRef } from "./pipeline/filters-binding.js";
import { isStandardSchema, type StandardSchemaV1 } from "./validation/standard-schema.js";

export interface SecurityOptions {
  /**
   * CORS is opt-in: pass `true` for hono's defaults or a config object.
   * (Earlier versions applied permissive CORS unconditionally.)
   */
  cors?: boolean | Parameters<typeof cors>[0];
  secureHeaders?: boolean | Parameters<typeof secureHeaders>[0];
}

export interface ObservabilityOptions {
  requestIdHeader?: string;
  enableAccessLogs?: boolean;
  logLevel?: "debug" | "info" | "warn" | "error";
  redactHeaders?: string[];
}

export interface ConfigOptions {
  /** Standard Schema validated against the env bindings, once per isolate. */
  schema: StandardSchemaV1;
  /** DI token the validated config is provided under. Default: CONFIG. */
  token?: Token;
}

/** Default DI token for the validated environment config. */
export const CONFIG: unique symbol = Symbol("honova:config");

export interface ApplicationOptions<Env extends Record<string, unknown>> {
  basePath?: string;
  globalMiddlewares?: MiddlewareHandler[];
  database?: DbManagerMiddlewareOptions<Env>;
  security?: SecurityOptions;
  observability?: ObservabilityOptions;
  di?: {
    strict?: boolean;
    /**
     * Resolve a constructor dependency from the parameter NAME when no other
     * token is available.
     *
     * On by default for compatibility, and it warns whenever it actually
     * resolves something — it reads identifiers out of
     * `Function.prototype.toString()`, so a minifier silently breaks it, and it
     * masks a genuinely missing token by appearing to work in development.
     *
     * Set it to `false` in any application that is minified or bundled, which
     * turns that silent degradation into a boot-time error. Prefer
     * `design:paramtypes` (`emitDecoratorMetadata`) or an explicit `@Inject`.
     */
    inferByParamName?: boolean;
  };
  /** Global guards, first in the guard chain. Classes are DI-resolved. */
  guards?: GuardRef[];
  /** Global interceptors, outermost in the onion. */
  interceptors?: InterceptorRef[];
  /** Global exception filters, last before the default mapping. */
  filters?: FilterRef[];
  /** Env-bindings validation + typed CONFIG provider. */
  config?: ConfigOptions;
  /** Respond 405 + Allow instead of 404 for known paths (hono middleware). */
  methodNotAllowed?: boolean;
}

const defaultRedactHeaders = ["authorization", "cookie", "set-cookie", "x-api-key"];

/** Context key holding the id assigned to the current request. */
export const REQUEST_ID_CONTEXT_KEY = "requestId";

/** Reads the current request id, wherever in the pipeline you are. */
export function getRequestId(c: { get(key: never): unknown }): string | undefined {
  return c.get(REQUEST_ID_CONTEXT_KEY as never) as string | undefined;
}

function createObservabilityMiddleware<Env extends Record<string, unknown>>(
  options: ObservabilityOptions | undefined,
): MiddlewareHandler<{ Bindings: Env }> {
  const requestIdHeader = options?.requestIdHeader ?? "x-request-id";
  const accessLogs = options?.enableAccessLogs ?? true;
  const level = options?.logLevel ?? "info";
  // Custom entries extend the defaults rather than replace them — replacing
  // silently re-enabled Authorization/Cookie logging at debug level.
  const redactHeaders = [...defaultRedactHeaders, ...(options?.redactHeaders ?? [])];

  // Client-supplied ids are convenient for tracing but must not become a
  // header/log injection vector: accept a conservative charset or mint one.
  const safeIdPattern = /^[A-Za-z0-9._-]{1,128}$/;

  return async (c, next) => {
    const incoming = c.req.header(requestIdHeader);
    const requestId = incoming && safeIdPattern.test(incoming) ? incoming : crypto.randomUUID();
    const start = Date.now();

    // Published on the context before the request runs, not just on the way
    // out: exception filters and handlers build response bodies mid-request and
    // need the same id that ends up in the header and the access log.
    c.set(REQUEST_ID_CONTEXT_KEY as never, requestId as never);

    await next();

    // c.header() instead of c.res.headers.set(): a handler that returns a
    // proxied fetch() Response has immutable headers, which .set() throws on.
    c.header(requestIdHeader, requestId);

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
  private configValidation: Promise<void> | undefined;
  private configOptions: ConfigOptions | undefined;

  constructor(options: ApplicationOptions<Env> = {}) {
    this.app = new Hono<{ Bindings: Env }>({ strict: false });
    this.container = new Container();
    this.container.configure({
      strict: options.di?.strict ?? true,
      inferByParamName: options.di?.inferByParamName ?? true,
    });
    Container.setActive(this.container);

    if (options.basePath) {
      this.app = this.app.basePath(options.basePath);
    }

    this.app.use("*", createObservabilityMiddleware(options.observability));

    if (options.security?.cors) {
      const settings =
        typeof options.security.cors === "boolean" ? undefined : options.security.cors;
      this.app.use("*", cors(settings));
    }

    if (options.security?.secureHeaders) {
      const settings =
        typeof options.security.secureHeaders === "boolean"
          ? undefined
          : options.security.secureHeaders;
      this.app.use("*", secureHeaders(settings));
    }

    if (options.config) {
      this.registerConfig(options.config);
    }

    if (options.database) {
      this.app.use("*", createDbManagerMiddleware(options.database));
    }

    for (const middleware of options.globalMiddlewares ?? []) {
      this.app.use("*", middleware);
    }

    if (options.methodNotAllowed) {
      this.app.use("*", methodNotAllowed({ app: this.app as never }));
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

    const globals: GlobalPipeline = {
      guards: options.guards ?? [],
      interceptors: options.interceptors ?? [],
      filters: options.filters ?? [],
    };
    this.router = new Router(this.app, this.container, globals);
  }

  /**
   * Validates env bindings once per isolate (single-flight across concurrent
   * first requests) and provides the parsed value under the config token.
   * Env bindings only exist at request time on Workers, so this cannot run at
   * construction.
   */
  private registerConfig(config: ConfigOptions): void {
    if (!isStandardSchema(config.schema)) {
      throw new Error("config.schema must implement Standard Schema v1 (zod >= 3.24, valibot, arktype).");
    }

    this.configOptions = config;
    this.app.use("*", async (c, next) => {
      await this.ensureConfig(c.env);
      await next();
    });
  }

  /**
   * Validates env bindings once per isolate and registers the CONFIG
   * provider. Public because non-fetch handlers (scheduled(), queue()) enter
   * outside the HTTP middleware chain and must be able to prepare config too.
   */
  async ensureConfig(env: unknown): Promise<void> {
    const config = this.configOptions;
    if (!config) {
      return;
    }

    if (!this.configValidation) {
      const token = config.token ?? CONFIG;
      this.configValidation = Promise.resolve(
        config.schema["~standard"].validate(env),
      ).then((result) => {
        if (result.issues) {
          const detail = result.issues.map((issue) => issue.message).join("; ");
          throw new Error(`Environment validation failed: ${detail}`);
        }

        this.container.registerProvider({ provide: token, useValue: result.value });
      });
      // Allow retry on the next request if validation itself failed.
      this.configValidation.catch(() => {
        this.configValidation = undefined;
      });
    }

    await this.configValidation;
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
        this.registerProviderDefinition(provider, moduleClass);
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

  private registerProviderDefinition(
    provider: ProviderDefinition,
    moduleClass: Constructor,
  ): void {
    if (typeof provider === "function") {
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

      return;
    }

    // Custom providers (useValue/useFactory/useClass/useExisting) need no
    // @Injectable — the definition itself is the registration.
    this.container.registerProvider(provider);

    if ("useClass" in provider) {
      this.registeredProviders.add(provider.useClass);
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

  /** Class providers registered so far — used by the scheduling dispatcher. */
  getRegisteredProviders(): Constructor[] {
    return [...this.registeredProviders];
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
