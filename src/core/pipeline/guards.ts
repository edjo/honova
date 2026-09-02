import type { Constructor } from "../types";
import type { ExecutionContext } from "../execution-context";

/**
 * Nest-style guard. Return false to reject with 403; throw an HttpException
 * for any other status (e.g. UnauthorizedException).
 */
export interface CanActivate {
  canActivate(ctx: ExecutionContext): boolean | Promise<boolean>;
}

/** A guard may be given as a DI-resolved class or a ready instance. */
export type GuardRef = Constructor<CanActivate> | CanActivate;

const classGuards = new WeakMap<Function, GuardRef[]>();
const methodGuards = new WeakMap<Function, GuardRef[]>();

function isStage3Context(candidate: unknown): candidate is { kind: string } {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof (candidate as { kind?: unknown }).kind === "string"
  );
}

export function UseGuards(...guards: GuardRef[]): ClassDecorator & MethodDecorator {
  return ((...args: unknown[]) => {
    // Stage-3 class or method decorator: (value, context)
    if (args.length === 2 && isStage3Context(args[1])) {
      const [value, context] = args as [Function, { kind: string }];
      const store = context.kind === "class" ? classGuards : methodGuards;
      store.set(value, [...(store.get(value) ?? []), ...guards]);
      return;
    }

    // Legacy method decorator: (target, propertyKey, descriptor)
    if (args.length === 3) {
      const [, , descriptor] = args as [object, string | symbol, PropertyDescriptor];
      const fn = descriptor?.value as Function | undefined;
      if (fn) {
        methodGuards.set(fn, [...(methodGuards.get(fn) ?? []), ...guards]);
      }
      return descriptor;
    }

    // Legacy class decorator: (target)
    const [target] = args as [Function];
    classGuards.set(target, [...(classGuards.get(target) ?? []), ...guards]);
  }) as ClassDecorator & MethodDecorator;
}

export function getClassGuards(target: Function | undefined): GuardRef[] {
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

  return chain.flatMap((cls) => classGuards.get(cls) ?? []);
}

export function getMethodGuards(handler: Function | undefined): GuardRef[] {
  return handler ? (methodGuards.get(handler) ?? []) : [];
}
