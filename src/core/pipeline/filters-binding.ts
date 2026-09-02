import type { Constructor } from "../types";
import type { ExceptionFilter } from "../exceptions/filters";

export type FilterRef = Constructor<ExceptionFilter> | ExceptionFilter;

const classFilters = new WeakMap<Function, FilterRef[]>();
const methodFilters = new WeakMap<Function, FilterRef[]>();

function isStage3Context(candidate: unknown): candidate is { kind: string } {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof (candidate as { kind?: unknown }).kind === "string"
  );
}

export function UseFilters(...filters: FilterRef[]): ClassDecorator & MethodDecorator {
  return ((...args: unknown[]) => {
    if (args.length === 2 && isStage3Context(args[1])) {
      const [value, context] = args as [Function, { kind: string }];
      const store = context.kind === "class" ? classFilters : methodFilters;
      store.set(value, [...(store.get(value) ?? []), ...filters]);
      return;
    }

    if (args.length === 3) {
      const [, , descriptor] = args as [object, string | symbol, PropertyDescriptor];
      const fn = descriptor?.value as Function | undefined;
      if (fn) {
        methodFilters.set(fn, [...(methodFilters.get(fn) ?? []), ...filters]);
      }
      return descriptor;
    }

    const [target] = args as [Function];
    classFilters.set(target, [...(classFilters.get(target) ?? []), ...filters]);
  }) as ClassDecorator & MethodDecorator;
}

export function getClassFilters(target: Function | undefined): FilterRef[] {
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

  return chain.flatMap((cls) => classFilters.get(cls) ?? []);
}

export function getMethodFilters(handler: Function | undefined): FilterRef[] {
  return handler ? (methodFilters.get(handler) ?? []) : [];
}
