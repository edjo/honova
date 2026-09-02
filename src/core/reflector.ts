import type { Constructor } from "./types";

/**
 * Custom metadata for classes and route handlers, mirroring Nest's
 * SetMetadata/Reflector pair without reflect-metadata: a WeakMap keyed by the
 * decorated function, holding a Map keyed by decorator identity.
 */
const customMetadata = new WeakMap<Function, Map<symbol, unknown>>();

export function setCustomMetadata(target: Function, key: symbol, value: unknown): void {
  const existing = customMetadata.get(target) ?? new Map<symbol, unknown>();
  existing.set(key, value);
  customMetadata.set(target, existing);
}

export function getCustomMetadata<T>(target: Function | undefined, key: symbol): T | undefined {
  if (!target) {
    return undefined;
  }

  return customMetadata.get(target)?.get(key) as T | undefined;
}

export interface MetadataDecorator<T> {
  (value: T): ClassDecorator & MethodDecorator;
  readonly key: symbol;
}

function isStage3Context(candidate: unknown): candidate is { kind: string } {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof (candidate as { kind?: unknown }).kind === "string"
  );
}

/**
 * Creates a typed metadata decorator usable on classes and methods, in both
 * legacy (experimentalDecorators) and TC39 stage-3 modes.
 *
 *   const Roles = createDecorator<string[]>("roles");
 *   @Roles(["admin"]) class AdminController { ... }
 */
export function createDecorator<T>(name = "honova:custom"): MetadataDecorator<T> {
  const key = Symbol(name);

  const decorator = (value: T) =>
    ((...args: unknown[]) => {
      // Stage-3: (value, context)
      if (args.length === 2 && isStage3Context(args[1])) {
        const [decorated] = args as [Function, { kind: string }];
        setCustomMetadata(decorated, key, value);
        return;
      }

      // Legacy method decorator: (target, propertyKey, descriptor)
      if (args.length === 3) {
        const [, , descriptor] = args as [object, string | symbol, PropertyDescriptor];
        if (typeof descriptor?.value === "function") {
          setCustomMetadata(descriptor.value, key, value);
        }
        return descriptor;
      }

      // Legacy class decorator: (target)
      const [target] = args as [Function];
      setCustomMetadata(target, key, value);
    }) as ClassDecorator & MethodDecorator;

  return Object.assign(decorator, { key }) as MetadataDecorator<T>;
}

/** Read side of createDecorator, with Nest's common lookup strategies. */
export class Reflector {
  get<T>(decorator: MetadataDecorator<T>, target: Function | undefined): T | undefined {
    return getCustomMetadata<T>(target, decorator.key);
  }

  /** Route handler value wins over controller class value. */
  getAllAndOverride<T>(
    decorator: MetadataDecorator<T>,
    targets: Array<Function | undefined>,
  ): T | undefined {
    for (const target of targets) {
      const value = getCustomMetadata<T>(target, decorator.key);
      if (value !== undefined) {
        return value;
      }
    }

    return undefined;
  }

  /** Shallow-merges array or object metadata from all targets. */
  getAllAndMerge<T>(
    decorator: MetadataDecorator<T>,
    targets: Array<Function | undefined>,
  ): T[] {
    const values: T[] = [];
    for (const target of targets) {
      const value = getCustomMetadata<T>(target, decorator.key);
      if (value !== undefined) {
        values.push(value);
      }
    }

    return values;
  }
}

export const reflector = new Reflector();
export type { Constructor };
