import type { MiddlewareHandler } from "hono";
import { Hono, type Context } from "hono";

import { Container } from "../container/container";
import type { Constructor, HttpMethod } from "../types";
import { getControllerMetadata, getRoutesMetadata } from "../metadata";

type RouteHandler = (ctx: Context) => Response | Promise<Response>;

export class Router<Env extends Record<string, unknown> = Record<string, unknown>> {
  constructor(
    private readonly app: Hono<{ Bindings: Env }>,
    private readonly container: Container,
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
      const handler: RouteHandler = async (c) => {
        const controller = this.container.resolveWithContext(controllerClass, c) as Record<
          PropertyKey,
          unknown
        >;
        const method = controller[route.handlerName];
        if (typeof method !== "function") {
          throw new Error(
            `Handler ${String(route.handlerName)} not found on ${controllerClass.name}`,
          );
        }
        return (method as (ctx: Context) => Response | Promise<Response>).call(controller, c);
      };

      this.registerRoute(route.method, fullPath, middlewares, handler);
    }
  }

  private registerRoute(
    method: HttpMethod,
    path: string,
    middlewares: MiddlewareHandler[],
    handler: RouteHandler,
  ): void {
    const handlers = middlewares.length > 0 ? [...middlewares, handler] : [handler];

    if (method === "HEAD") {
      this.app.on("HEAD", [path], ...handlers);
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
