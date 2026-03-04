import type { MiddlewareHandler, Context as HonoContext } from "hono";

export type Constructor<T = unknown> = new (...args: never[]) => T;

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "OPTIONS"
  | "HEAD";

export interface RouteDefinition {
  method: HttpMethod;
  path: string;
  handlerName: string | symbol;
  middlewares: MiddlewareHandler[];
}

export interface ControllerMetadata {
  prefix: string;
  middlewares: MiddlewareHandler[];
}

export interface ModuleMetadata {
  controllers?: Constructor[];
  providers?: Constructor[];
  imports?: Constructor[];
}

export interface InjectableMetadata {
  scope: "singleton" | "request" | "transient";
  autoResolve?: boolean;
}

export interface OnModuleInit<TContext = unknown> {
  onModuleInit(context?: TContext): void;
}

export type HandlerFunction<Env extends Record<string, unknown>> = (
  ctx: HonoContext<{ Bindings: Env }>,
) => Response | Promise<Response>;
