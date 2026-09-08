import type { InjectableMetadata } from "../types.js";
import { setInjectableMetadata } from "../metadata.js";

export interface InjectableOptions {
  scope?: "singleton" | "request" | "transient";
  autoResolve?: boolean;
}

export function Injectable(options: InjectableOptions = {}): ClassDecorator {
  return (target) => {
    setInjectableMetadata(target, {
      scope: options.scope ?? "singleton",
      autoResolve: options.autoResolve ?? true,
    } satisfies InjectableMetadata);
  };
}
