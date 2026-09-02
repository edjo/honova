import type { Constructor } from "./types";

/**
 * Constructor parameter TYPES, for dependency resolution.
 *
 * TypeScript's `emitDecoratorMetadata` emits a `design:paramtypes` entry for
 * every decorated class, holding the actual constructor parameter types as
 * value references. Resolving dependencies from that is what lets a consumer
 * write
 *
 *     constructor(private readonly links: LinkService) {}
 *
 * instead of repeating `@Inject(LinkService)` on every parameter — the module
 * already declares the providers, so the constructor only has to name the type.
 *
 * Why this is safe where parameter-NAME inference is not: the emitted metadata
 * references the class binding itself, so a minifier renames it consistently.
 * Name-based inference reads identifiers out of `Function.prototype.toString()`
 * and breaks the moment anything is renamed.
 *
 * Why not `reflect-metadata`: the emitted helper only ever calls
 * `Reflect.metadata(key, value)` and only ever for this one key, so the full
 * polyfill is ~50 KB of general-purpose metadata machinery to support a
 * two-line need — a poor trade against a Worker's 1 s global-scope startup
 * budget. This is the same WeakMap approach the rest of honova's metadata uses.
 *
 * Consumers opt in with `emitDecoratorMetadata: true`; without it, nothing is
 * emitted, this map stays empty, and explicit `@Inject` tokens still work
 * exactly as before.
 */
const DESIGN_PARAM_TYPES = "design:paramtypes";

const paramTypes = new WeakMap<Function, unknown[]>();

interface MetadataReflect {
  metadata?: (key: string, value: unknown) => (target: unknown) => void;
  getMetadata?: (key: string, target: unknown) => unknown;
}

/**
 * Installs the two `Reflect` functions the TypeScript helper looks for.
 *
 * Idempotent, and it never replaces an existing implementation: an application
 * that already loads `reflect-metadata` (or another framework that installs it)
 * keeps its own, and honova reads through `getMetadata` either way.
 */
export function installDesignTypeMetadata(): void {
  const reflect = Reflect as MetadataReflect;

  reflect.metadata ??= (key: string, value: unknown) => {
    return (target: unknown) => {
      if (key === DESIGN_PARAM_TYPES && typeof target === "function" && Array.isArray(value)) {
        paramTypes.set(target, value);
      }
    };
  };

  reflect.getMetadata ??= (key: string, target: unknown) => {
    return key === DESIGN_PARAM_TYPES && typeof target === "function"
      ? paramTypes.get(target)
      : undefined;
  };
}

installDesignTypeMetadata();

/**
 * The declared constructor parameter types, or an empty array when the consumer
 * has not enabled `emitDecoratorMetadata`.
 *
 * Primitives are filtered out: `design:paramtypes` reports `String`, `Number`,
 * `Object` and friends for non-class parameters, and those are never injectable
 * tokens. Returning `undefined` in their slot lets an explicit `@Inject` or a
 * `static inject` entry fill the gap, and produces a clear error if nothing
 * does.
 */
export function getConstructorParamTypes(target: Constructor): Array<Constructor | undefined> {
  const reflect = Reflect as MetadataReflect;
  const declared = reflect.getMetadata?.(DESIGN_PARAM_TYPES, target);

  if (!Array.isArray(declared)) {
    return [];
  }

  return declared.map((type) => (isInjectableType(type) ? (type as Constructor) : undefined));
}

const NON_INJECTABLE_TYPES: readonly unknown[] = [
  Object,
  String,
  Number,
  Boolean,
  Array,
  Function,
  Symbol,
  Date,
  Promise,
];

function isInjectableType(type: unknown): boolean {
  return typeof type === "function" && !NON_INJECTABLE_TYPES.includes(type);
}
