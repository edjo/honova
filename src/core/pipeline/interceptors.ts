import type { Constructor } from "../types.js";
import type { ExecutionContext } from "../execution-context.js";

/**
 * RxJS-free interceptor: an async onion around the handler.
 *
 * `next()` runs the rest of the pipeline (inner interceptors, validation, the
 * handler) and resolves with the handler's return value — not yet a Response,
 * so interceptors can reshape it ({ data: result }), measure around it, or
 * short-circuit by returning without calling next(). Every documented Nest
 * interceptor use case (map/tap/catchError/cache/timeout) is expressible with
 * try/await/return.
 */
export interface HonovaInterceptor {
  intercept(ctx: ExecutionContext, next: () => Promise<unknown>): Promise<unknown>;
}

export type InterceptorRef = Constructor<HonovaInterceptor> | HonovaInterceptor;

const classInterceptors = new WeakMap<Function, InterceptorRef[]>();
const methodInterceptors = new WeakMap<Function, InterceptorRef[]>();

function isStage3Context(candidate: unknown): candidate is { kind: string } {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof (candidate as { kind?: unknown }).kind === "string"
  );
}

export function UseInterceptors(
  ...interceptors: InterceptorRef[]
): ClassDecorator & MethodDecorator {
  return ((...args: unknown[]) => {
    if (args.length === 2 && isStage3Context(args[1])) {
      const [value, context] = args as [Function, { kind: string }];
      const store = context.kind === "class" ? classInterceptors : methodInterceptors;
      store.set(value, [...(store.get(value) ?? []), ...interceptors]);
      return;
    }

    if (args.length === 3) {
      const [, , descriptor] = args as [object, string | symbol, PropertyDescriptor];
      const fn = descriptor?.value as Function | undefined;
      if (fn) {
        methodInterceptors.set(fn, [...(methodInterceptors.get(fn) ?? []), ...interceptors]);
      }
      return descriptor;
    }

    const [target] = args as [Function];
    classInterceptors.set(target, [...(classInterceptors.get(target) ?? []), ...interceptors]);
  }) as ClassDecorator & MethodDecorator;
}

export function getClassInterceptors(target: Function | undefined): InterceptorRef[] {
  if (!target) {
    return [];
  }

  // Include bindings declared on base classes (base-first, so a parent's
  // bindings run before the child's).
  const chain: Function[] = [];
  let current: unknown = target;
  while (typeof current === "function" && current !== Function.prototype) {
    chain.unshift(current);
    current = Object.getPrototypeOf(current);
  }

  return chain.flatMap((cls) => classInterceptors.get(cls) ?? []);
}

export function getMethodInterceptors(handler: Function | undefined): InterceptorRef[] {
  return handler ? (methodInterceptors.get(handler) ?? []) : [];
}
