import type { ControllerMetadata } from "../types";
import {
  getControllerMetadata,
  getInjectableMetadata,
  getMethodRouteMetadata,
  setControllerMetadata,
  setInjectableMetadata,
  setRoutesMetadata,
} from "../metadata";

function collectRoutesFromPrototype(target: Function): void {
  const rootPrototype = target.prototype as object | undefined;
  if (!rootPrototype) {
    return;
  }

  // Walk the prototype chain so controllers can extend decorated base
  // classes. Child-most declaration of a name wins; when a child overrides a
  // decorated method without re-decorating it, the base method's route
  // metadata still applies (the router dispatches by handler name, so the
  // override is what actually runs).
  const seen = new Set<string | symbol>();
  const routes: NonNullable<ReturnType<typeof getMethodRouteMetadata>>[] = [];

  let prototype: object | null = rootPrototype;
  while (prototype && prototype !== Object.prototype) {
    const names = [
      ...Object.getOwnPropertyNames(prototype),
      ...Object.getOwnPropertySymbols(prototype),
    ].filter((name) => name !== "constructor");

    for (const name of names) {
      if (seen.has(name)) {
        continue;
      }
      seen.add(name);

      // Find the closest-to-child function carrying route metadata under
      // this name anywhere up the chain.
      let level: object | null = prototype;
      while (level && level !== Object.prototype) {
        const descriptor = Object.getOwnPropertyDescriptor(level, name);
        const value = descriptor?.value;
        if (typeof value === "function") {
          const route = getMethodRouteMetadata(value);
          if (route) {
            routes.push(route);
            break;
          }
        }
        level = Object.getPrototypeOf(level);
      }
    }

    prototype = Object.getPrototypeOf(prototype);
  }

  setRoutesMetadata(target, routes);
}

function applyControllerDecorator(target: Function, prefix: string): void {
    const normalizedPrefix = prefix.startsWith("/") ? prefix : `/${prefix}`;
    const existing = getControllerMetadata(target) as Partial<ControllerMetadata> | undefined;

    setControllerMetadata(target, {
      prefix: normalizedPrefix,
      middlewares: existing?.middlewares ?? [],
    });

    if (!getInjectableMetadata(target)) {
      setInjectableMetadata(target, {
        scope: "singleton",
        autoResolve: true,
      });
    }

    collectRoutesFromPrototype(target);
}

export function Controller(prefix = ""): ClassDecorator {
  return ((...args: unknown[]) => {
    if (
      args.length === 2 &&
      typeof args[1] === "object" &&
      args[1] !== null &&
      (args[1] as { kind?: string }).kind === "class"
    ) {
      const [value] = args as [Function, { kind: "class" }];
      applyControllerDecorator(value, prefix);
      return;
    }

    const [target] = args as [Function];
    applyControllerDecorator(target, prefix);
  }) as ClassDecorator;
}
