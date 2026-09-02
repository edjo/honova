import type { Constructor } from "../types";
import { setInjectionToken } from "../metadata";
import { Container } from "../container/container";

type InjectToken = Constructor | string | symbol;

/**
 * Token-based injection, in every decorator mode that can express it:
 *
 * - Legacy constructor parameter (experimentalDecorators):
 *     constructor(@Inject(DB) private readonly db: Db) {}
 * - TC39 stage-3 field or accessor (parameter decorators do not exist in
 *   stage-3 — they are a separate stage-1 proposal):
 *     @Inject(DB) accessor db!: Db;
 *
 * Stage-3 injection resolves from the active container at construction time,
 * so it supports singleton and request-scoped providers but not async
 * factories (those need the constructor path through resolveAsync).
 */
export function Inject(token: InjectToken): any {
  return (...args: unknown[]): unknown => {
    // Stage-3 field decorator: (undefined, context { kind: "field" })
    if (
      args.length === 2 &&
      typeof args[1] === "object" &&
      args[1] !== null &&
      (args[1] as { kind?: string }).kind === "field"
    ) {
      return function initialize(this: unknown): unknown {
        return Container.getActive().resolve(token);
      };
    }

    // Stage-3 accessor decorator: (target, context { kind: "accessor" })
    if (
      args.length === 2 &&
      typeof args[1] === "object" &&
      args[1] !== null &&
      (args[1] as { kind?: string }).kind === "accessor"
    ) {
      return {
        init(): unknown {
          return Container.getActive().resolve(token);
        },
      };
    }

    // Legacy parameter decorator: (target, propertyKey, parameterIndex)
    const [target, , parameterIndex] = args as [
      object | Function,
      string | symbol | undefined,
      number,
    ];

    if (typeof parameterIndex !== "number") {
      throw new Error(
        "@Inject() supports constructor parameters (legacy decorators) and " +
          "fields/accessors (stage-3 decorators).",
      );
    }

    const injectionTarget =
      typeof target === "function" ? target : (target.constructor as Function);

    setInjectionToken(injectionTarget, parameterIndex, token);
    return undefined;
  };
}
