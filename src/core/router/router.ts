import type { MiddlewareHandler } from "hono";
import { Hono, type Context } from "hono";

import { Container } from "../container/container.js";
import type { Constructor, HttpMethod } from "../types.js";
import { getControllerMetadata, getRoutesMetadata } from "../metadata.js";
import { ExecutionContext } from "../execution-context.js";
import { ForbiddenException } from "../exceptions/http-exception.js";
import {
  defaultExceptionResponse,
  filterMatches,
  type ExceptionFilter,
} from "../exceptions/filters.js";
import {
  getClassGuards,
  getMethodGuards,
  type CanActivate,
  type GuardRef,
} from "../pipeline/guards.js";
import {
  getClassInterceptors,
  getMethodInterceptors,
  type HonovaInterceptor,
  type InterceptorRef,
} from "../pipeline/interceptors.js";
import {
  getClassFilters,
  getMethodFilters,
  type FilterRef,
} from "../pipeline/filters-binding.js";
import { getValidateSchemas, runValidation } from "../validation/validate.js";
import { getResponseExtras } from "../decorators/http-response.js";

export interface GlobalPipeline {
  guards: GuardRef[];
  interceptors: InterceptorRef[];
  filters: FilterRef[];
}

type RouteHandler = (ctx: Context) => Response | Promise<Response>;

export class Router<Env extends Record<string, unknown> = Record<string, unknown>> {
  constructor(
    private readonly app: Hono<{ Bindings: Env }>,
    private readonly container: Container,
    private readonly globals: GlobalPipeline = { guards: [], interceptors: [], filters: [] },
  ) {}

  registerController(controllerClass: Constructor): void {
    const controllerMetadata = getControllerMetadata(controllerClass);

    if (!controllerMetadata) {
      throw new Error(`Class ${controllerClass.name} is not decorated with @Controller()`);
    }

    const routes = getRoutesMetadata(controllerClass);

    for (const route of routes) {
      const fullPath = this.normalizePath(controllerMetadata.prefix + route.path);
      const middlewares = [...controllerMetadata.middlewares, ...route.middlewares];
      const handler = this.createPipelineHandler(controllerClass, route.handlerName);

      try {
        this.registerRoute(route.method, fullPath, middlewares, handler);
      } catch (error) {
        // Since hono 4.13 the router throws UnsupportedPathError at
        // registration; name the offender instead of surfacing a bare error.
        throw new Error(
          `Failed to register ${route.method} ${fullPath} ` +
            `(${controllerClass.name}.${String(route.handlerName)}): ` +
            `${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }
  }

  /**
   * The request pipeline, in Nest's canonical order:
   * guards -> interceptors (onion) -> validation -> handler -> serialization,
   * with exceptions mapped by filters (route -> controller -> global -> default).
   */
  private createPipelineHandler(
    controllerClass: Constructor,
    handlerName: string | symbol,
  ): RouteHandler {
    return async (c) => {
      const prototype = controllerClass.prototype as Record<PropertyKey, unknown>;
      const methodFn = prototype[handlerName] as Function | undefined;
      const execCtx = new ExecutionContext(c, controllerClass, methodFn, handlerName);

      try {
        const controller = (await this.container.resolveWithContextAsync(
          controllerClass,
          c,
        )) as Record<PropertyKey, unknown>;

        const method = controller[handlerName];
        if (typeof method !== "function") {
          throw new Error(
            `Handler ${String(handlerName)} not found on ${controllerClass.name}`,
          );
        }

        await this.runGuards(execCtx, c, controllerClass, methodFn);

        const invokeHandler = async (): Promise<unknown> => {
          const schemas = getValidateSchemas(methodFn);
          if (schemas) {
            await runValidation(c, schemas);
          }

          return (method as (ctx: Context) => unknown).call(controller, c);
        };

        const result = await this.runInterceptors(
          execCtx,
          c,
          controllerClass,
          methodFn,
          invokeHandler,
        );

        return this.serialize(c, result, methodFn);
      } catch (exception) {
        return this.applyFilters(exception, execCtx, c, controllerClass, methodFn);
      }
    };
  }

  private async runGuards(
    execCtx: ExecutionContext,
    c: Context,
    controllerClass: Constructor,
    methodFn: Function | undefined,
  ): Promise<void> {
    const refs = [
      ...this.globals.guards,
      ...getClassGuards(controllerClass),
      ...getMethodGuards(methodFn),
    ];

    for (const ref of refs) {
      const guard = await this.materialize<CanActivate>(ref, c);
      const allowed = await guard.canActivate(execCtx);
      if (!allowed) {
        throw new ForbiddenException();
      }
    }
  }

  private async runInterceptors(
    execCtx: ExecutionContext,
    c: Context,
    controllerClass: Constructor,
    methodFn: Function | undefined,
    invokeHandler: () => Promise<unknown>,
  ): Promise<unknown> {
    const refs = [
      ...this.globals.interceptors,
      ...getClassInterceptors(controllerClass),
      ...getMethodInterceptors(methodFn),
    ];

    if (refs.length === 0) {
      return invokeHandler();
    }

    const instances: HonovaInterceptor[] = [];
    for (const ref of refs) {
      instances.push(await this.materialize<HonovaInterceptor>(ref, c));
    }

    // Build the onion inside-out so the first-listed interceptor is outermost
    // (enters first, leaves last) — Nest's FILO semantics.
    let next = invokeHandler;
    for (const interceptor of [...instances].reverse()) {
      const inner = next;
      next = () => Promise.resolve(interceptor.intercept(execCtx, inner));
    }

    return next();
  }

  private async applyFilters(
    exception: unknown,
    execCtx: ExecutionContext,
    c: Context,
    controllerClass: Constructor | undefined,
    methodFn: Function | undefined,
  ): Promise<Response> {
    const refs = [
      ...getMethodFilters(methodFn),
      ...getClassFilters(controllerClass),
      ...this.globals.filters,
    ];

    for (const ref of refs) {
      const filterClass = typeof ref === "function" ? ref : (ref.constructor as Constructor);
      if (!filterMatches(filterClass, exception)) {
        continue;
      }

      try {
        const filter = await this.materialize<ExceptionFilter>(ref, c);
        const response = await filter.catch(exception, execCtx);
        if (response instanceof Response) {
          return response;
        }
      } catch (filterError) {
        console.error("Exception filter threw:", filterError);
      }
    }

    return defaultExceptionResponse(exception, c);
  }

  /**
   * Guards/interceptors/filters may be DI classes or plain instances. Classes
   * are auto-registered on first use so they need no @Injectable unless they
   * declare dependencies or a non-default scope.
   */
  private async materialize<T>(ref: Constructor<T> | T, c: Context): Promise<T> {
    if (typeof ref !== "function") {
      return ref;
    }

    const token = ref as Constructor<T>;
    if (!this.container.has(token)) {
      this.container.register(token);
    }

    return this.container.resolveWithContextAsync(token, c);
  }

  private serialize(c: Context, result: unknown, methodFn: Function | undefined): Response {
    if (result instanceof Response) {
      return result;
    }

    const extras = getResponseExtras(methodFn);
    for (const [name, value] of Object.entries(extras?.headers ?? {})) {
      c.header(name, value);
    }

    if (result === undefined || result === null) {
      return c.body(null, (extras?.httpCode ?? 204) as never);
    }

    // Binary and stream results must not be JSON-mangled.
    if (
      result instanceof ReadableStream ||
      result instanceof ArrayBuffer ||
      ArrayBuffer.isView(result) ||
      (typeof Blob !== "undefined" && result instanceof Blob)
    ) {
      return c.body(result as never, (extras?.httpCode ?? 200) as never);
    }

    if (typeof result === "string") {
      return c.text(result, (extras?.httpCode ?? 200) as never);
    }

    return c.json(result as never, (extras?.httpCode ?? 200) as never);
  }

  private registerRoute(
    method: HttpMethod,
    path: string,
    middlewares: MiddlewareHandler[],
    handler: RouteHandler,
  ): void {
    const handlers = middlewares.length > 0 ? [...middlewares, handler] : [handler];

    if (method === "HEAD" || method === "QUERY") {
      this.app.on(method, [path], ...handlers);
      return;
    }

    switch (method) {
      case "GET":
        (this.app as any).get(path, ...handlers);
        return;
      case "POST":
        (this.app as any).post(path, ...handlers);
        return;
      case "PUT":
        (this.app as any).put(path, ...handlers);
        return;
      case "PATCH":
        (this.app as any).patch(path, ...handlers);
        return;
      case "DELETE":
        (this.app as any).delete(path, ...handlers);
        return;
      case "OPTIONS":
        (this.app as any).options(path, ...handlers);
        return;
      default:
        throw new Error(`Unsupported method: ${String(method)}`);
    }
  }

  private normalizePath(path: string): string {
    return path.replace(/\/+$/g, "").replace(/\/+/g, "/") || "/";
  }
}
