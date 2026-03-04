import type {
  ControllerMetadata,
  InjectableMetadata,
  ModuleMetadata,
  RouteDefinition,
  Constructor,
} from "./types";

const moduleMetadata = new WeakMap<Function, ModuleMetadata>();
const controllerMetadata = new WeakMap<Function, ControllerMetadata>();
const routesMetadata = new WeakMap<Function, RouteDefinition[]>();
const methodRouteMetadata = new WeakMap<Function, RouteDefinition>();
const injectableMetadata = new WeakMap<Function, InjectableMetadata>();
const injectionMetadata = new WeakMap<Function, Map<number, Constructor | string | symbol>>();

export function setModuleMetadata(target: Function, metadata: ModuleMetadata): void {
  moduleMetadata.set(target, metadata);
}

export function getModuleMetadata(target: Function): ModuleMetadata | undefined {
  return moduleMetadata.get(target);
}

export function setControllerMetadata(target: Function, metadata: ControllerMetadata): void {
  controllerMetadata.set(target, metadata);
}

export function getControllerMetadata(target: Function): ControllerMetadata | undefined {
  return controllerMetadata.get(target);
}

export function appendRouteMetadata(target: Function, route: RouteDefinition): void {
  const existing = routesMetadata.get(target) ?? [];
  routesMetadata.set(target, [...existing, route]);
}

export function setRoutesMetadata(target: Function, routes: RouteDefinition[]): void {
  routesMetadata.set(target, routes);
}

export function getRoutesMetadata(target: Function): RouteDefinition[] {
  return routesMetadata.get(target) ?? [];
}

export function setMethodRouteMetadata(
  method: Function,
  route: RouteDefinition,
): void {
  methodRouteMetadata.set(method, route);
}

export function getMethodRouteMetadata(
  method: Function,
): RouteDefinition | undefined {
  return methodRouteMetadata.get(method);
}

export function prependRouteMiddlewares(
  target: Function,
  handlerName: string | symbol,
  middlewares: RouteDefinition["middlewares"],
): void {
  const routes = routesMetadata.get(target) ?? [];
  const index = routes.findIndex((route) => route.handlerName === handlerName);

  if (index < 0) {
    return;
  }

  const next = [...routes];
  next[index] = {
    ...next[index],
    middlewares: [...middlewares, ...next[index].middlewares],
  };

  routesMetadata.set(target, next);
}

export function prependMethodRouteMiddlewares(
  method: Function,
  middlewares: RouteDefinition["middlewares"],
): void {
  const existing = methodRouteMetadata.get(method);
  if (!existing) {
    return;
  }

  methodRouteMetadata.set(method, {
    ...existing,
    middlewares: [...middlewares, ...existing.middlewares],
  });
}

export function setInjectableMetadata(target: Function, metadata: InjectableMetadata): void {
  injectableMetadata.set(target, metadata);
}

export function getInjectableMetadata(target: Function): InjectableMetadata | undefined {
  return injectableMetadata.get(target);
}

export function setInjectionToken(
  target: Function,
  index: number,
  token: Constructor | string | symbol,
): void {
  const existing = injectionMetadata.get(target) ?? new Map<number, Constructor | string | symbol>();
  existing.set(index, token);
  injectionMetadata.set(target, existing);
}

export function getInjectionTokens(
  target: Function,
): Map<number, Constructor | string | symbol> {
  return injectionMetadata.get(target) ?? new Map<number, Constructor | string | symbol>();
}
