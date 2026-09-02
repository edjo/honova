import type { MiddlewareHandler, Context as HonoContext } from "hono";

export type Constructor<T = unknown> = new (...args: never[]) => T;

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "OPTIONS"
  | "HEAD"
  | "QUERY";

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

export type Token<T = unknown> = Constructor<T> | string | symbol;

export type InjectionScope = "singleton" | "request" | "transient";

export interface ValueProvider {
  provide: Token;
  useValue: unknown;
}

export interface FactoryProvider {
  provide: Token;
  useFactory: (...deps: never[]) => unknown;
  inject?: Token[];
  scope?: InjectionScope;
}

export interface ClassProvider {
  provide: Token;
  useClass: Constructor;
  /** Overrides the class's own @Injectable scope for this token. */
  scope?: InjectionScope;
}

export interface ExistingProvider {
  provide: Token;
  useExisting: Token;
}

export type CustomProvider =
  | ValueProvider
  | FactoryProvider
  | ClassProvider
  | ExistingProvider;

export type ProviderDefinition = Constructor | CustomProvider;

export interface ModuleMetadata {
  controllers?: Constructor[];
  providers?: ProviderDefinition[];
  imports?: Constructor[];
}

export interface InjectableMetadata {
  scope: "singleton" | "request" | "transient";
  autoResolve?: boolean;
}

export interface OnModuleInit<TContext = unknown> {
  /** May be async; async inits are awaited by the request pipeline. */
  onModuleInit(context?: TContext): void | Promise<void>;
}

export type HandlerFunction<Env extends Record<string, unknown>> = (
  ctx: HonoContext<{ Bindings: Env }>,
) => Response | Promise<Response>;
