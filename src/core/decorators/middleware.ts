import type { MiddlewareHandler } from "hono";

import {
  getControllerMetadata,
  prependMethodRouteMiddlewares,
  prependRouteMiddlewares,
  setControllerMetadata,
} from "../metadata";

function applyControllerMiddlewares(target: Function, middlewares: MiddlewareHandler[]): void {
  const existing = getControllerMetadata(target);

  setControllerMetadata(target, {
    prefix: existing?.prefix ?? "",
    middlewares: [...(existing?.middlewares ?? []), ...middlewares],
  });
}

export function UseMiddleware(...middlewares: MiddlewareHandler[]) {
  return ((...args: unknown[]) => {
    // Standard class decorator: (value, context)
    if (
      args.length === 2 &&
      typeof args[1] === "object" &&
      args[1] !== null &&
      (args[1] as { kind?: string }).kind === "class"
    ) {
      const [value] = args as [Function, { kind: "class" }];
      applyControllerMiddlewares(value, middlewares);
      return;
    }

    // Standard method decorator: (value, context)
    if (
      args.length === 2 &&
      typeof args[1] === "object" &&
      args[1] !== null &&
      (args[1] as { kind?: string }).kind === "method"
    ) {
      const [value] = args as [Function, { kind: "method" }];
      prependMethodRouteMiddlewares(value, middlewares);
      return;
    }

    // Legacy method decorator: (target, propertyKey, descriptor)
    if (args.length === 3) {
      const [target, propertyKey, descriptor] = args as [
        object,
        string | symbol,
        PropertyDescriptor,
      ];

      const fn = (descriptor?.value as Function | undefined) ??
        ((target as Record<string | symbol, unknown>)[propertyKey] as
          | Function
          | undefined);
      if (fn) {
        prependMethodRouteMiddlewares(fn, middlewares);
      }

      prependRouteMiddlewares(target.constructor as Function, propertyKey, middlewares);
      return descriptor;
    }

    // Legacy class decorator: (target)
    const [target] = args as [Function];
    applyControllerMiddlewares(target, middlewares);
  }) as ClassDecorator & MethodDecorator;
}
