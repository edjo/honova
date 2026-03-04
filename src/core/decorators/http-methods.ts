import type { MiddlewareHandler } from "hono";

import type { HttpMethod } from "../types";
import { setMethodRouteMetadata } from "../metadata";

function isStandardMethodDecoratorArgs(args: unknown[]): boolean {
  if (args.length !== 2) {
    return false;
  }

  const context = args[1] as { kind?: string } | undefined;
  return !!context && typeof context === "object" && context.kind === "method";
}

function createMethodDecorator(method: HttpMethod) {
  return (path = "", ...middlewares: MiddlewareHandler[]) => {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;

    return (...args: unknown[]) => {
      if (isStandardMethodDecoratorArgs(args)) {
        const [value, context] = args as [
          Function,
          { kind: "method"; name: string | symbol },
        ];

        setMethodRouteMetadata(value, {
          method,
          path: normalizedPath,
          handlerName: context.name,
          middlewares,
        });

        return;
      }

      const [target, propertyKey, descriptor] = args as [
        object,
        string | symbol,
        PropertyDescriptor,
      ];
      const methodFn = (descriptor?.value as Function | undefined) ??
        ((target as Record<string | symbol, unknown>)[propertyKey] as
          | Function
          | undefined);

      if (methodFn) {
        setMethodRouteMetadata(methodFn, {
          method,
          path: normalizedPath,
          handlerName: propertyKey,
          middlewares,
        });
      }

      return descriptor;
    };
  };
}

export const Get = createMethodDecorator("GET");
export const Post = createMethodDecorator("POST");
export const Put = createMethodDecorator("PUT");
export const Patch = createMethodDecorator("PATCH");
export const Delete = createMethodDecorator("DELETE");
export const Options = createMethodDecorator("OPTIONS");
export const Head = createMethodDecorator("HEAD");
