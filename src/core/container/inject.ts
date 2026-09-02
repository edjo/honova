import type { Constructor } from "../types";
import { Container } from "./container";

/**
 * Resolves from the active container — the one belonging to the most recently
 * created Application or testing module. (Previously this consulted the
 * detached global singleton and never saw application providers.)
 */
export function inject<T>(token: Constructor<T>): T {
  const container = Container.getActive();
  if (!container.has(token)) {
    throw new Error(
      `Provider "${token.name || "UnknownProvider"}" is not registered. Add it in @Module({ providers: [...] }).`,
    );
  }

  return container.resolve(token);
}
