/**
 * Transparent lazy database access.
 *
 * A connection declared `lazy` is not opened when the request starts, so
 * `c.db` has nothing to point at yet. Rather than making every consumer write
 * `await manager.connection("main")` — which pushes a lifecycle detail into
 * application code and loses the inferred type — the middleware puts this proxy
 * on the context.
 *
 * It defers to the real client at the moment a method is actually CALLED:
 *
 *     const user = await c.db.user.findFirst(...)
 *                       ^^^^^^^^^^^^^^^^^^^^ resolves the connection here
 *
 * Every database client worth wrapping exposes its operations as async methods
 * (Prisma delegates, Drizzle query builders, Mongo collections), so deferring at
 * call time is enough — and it keeps the inferred type intact, because the proxy
 * is typed as the client it stands in for.
 *
 * What a request that never queries pays: nothing. No connect, no driver
 * import, no pool. That is the point on a serverless runtime with a bounded
 * origin connection budget, where health checks, 404s and rejected requests are
 * a large share of traffic.
 */
export function createLazyClientProxy<T extends object>(resolve: () => Promise<unknown>): T {
  return buildProxy(resolve, []) as T;
}

function buildProxy(resolve: () => Promise<unknown>, path: readonly PropertyKey[]): unknown {
  // The proxy target is a function so both `get` and `apply` traps are legal;
  // the target itself is never invoked.
  const target = (): void => undefined;

  return new Proxy(target, {
    get(_target, property) {
      // `then` must not be trapped: an accidental `await c.db` would otherwise
      // look like a thenable and hang, or resolve to a proxy.
      if (property === "then") return undefined;
      if (typeof property === "symbol") return undefined;

      return buildProxy(resolve, [...path, property]);
    },

    apply(_target, _thisArg, args: unknown[]) {
      return (async () => {
        const client = await resolve();
        const { receiver, method } = walk(client, path);

        if (typeof method !== "function") {
          throw new TypeError(
            `Database client has no callable "${path.map(String).join(".")}".`,
          );
        }

        return (method as (...callArgs: unknown[]) => unknown).apply(receiver, args);
      })();
    },
  });
}

/** Walks the recorded property path, keeping the correct `this` for the call. */
function walk(client: unknown, path: readonly PropertyKey[]): { receiver: unknown; method: unknown } {
  let receiver: unknown = client;
  let current: unknown = client;

  for (const key of path) {
    if (current === null || current === undefined) {
      throw new TypeError(`Database client has no "${path.map(String).join(".")}".`);
    }

    receiver = current;
    current = (current as Record<PropertyKey, unknown>)[key];
  }

  return { receiver, method: current };
}
