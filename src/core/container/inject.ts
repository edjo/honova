import type { Constructor } from "../types";
import { Container } from "./container";

export function inject<T>(token: Constructor<T>): T {
  const container = Container.getInstance();
  if (!container.has(token)) {
    throw new Error(
      `Provider "${token.name || "UnknownProvider"}" is not registered. Add it in @Module({ providers: [...] }).`,
    );
  }

  return container.resolve(token);
}
