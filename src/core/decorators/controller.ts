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
  const prototype = target.prototype as Record<string | symbol, unknown> | undefined;
  if (!prototype) {
    return;
  }

  const names = [
    ...Object.getOwnPropertyNames(prototype),
    ...Object.getOwnPropertySymbols(prototype),
  ].filter((name) => name !== "constructor");

  const routes = names
    .map((name) => {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      const value = descriptor?.value;
      if (typeof value !== "function") {
        return undefined;
      }
      return getMethodRouteMetadata(value);
    })
    .filter((route): route is NonNullable<typeof route> => !!route);

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
