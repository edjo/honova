/**
 * Marking a handler as reachable without the application's global guards.
 *
 * Global guards are how an application makes authentication the default rather
 * than something each route remembers — the inversion that stops a new route
 * shipping unprotected because nobody added a decorator. But every such
 * application then needs a way for the handful of genuinely open routes to say
 * so: a health check, a login form, a liveness probe, an OAuth metadata
 * document a client reads before it has any credential.
 *
 * That marker was being reimplemented per application, each with its own
 * `WeakSet` and its own spelling, which has two costs. A second application
 * gets it subtly different, and a guard in a shared package cannot honour a
 * marker it has no way to import.
 *
 * ## The framework marks; the guard decides
 *
 * This deliberately does NOT make the router skip guards. A guard is the only
 * thing that knows whether "public" applies to it — a CSRF guard usually still
 * wants to run on an open form POST, while a session guard does not. So the
 * decorator records intent and each guard chooses to honour it:
 *
 * ```ts
 * async canActivate(ctx: ExecutionContext) {
 *   if (isPublicHandler(ctx.getHandler())) return true;
 *   // …
 * }
 * ```
 *
 * Keyed on the handler FUNCTION rather than on a route path, so a handler
 * cannot be moved, renamed or copied into another controller and quietly lose
 * — or quietly keep — its exemption.
 */
const publicHandlers = new WeakSet<object>();

export function Public(): MethodDecorator {
  return ((_target: object, _key: string | symbol, descriptor: PropertyDescriptor) => {
    const handler: unknown = descriptor.value;
    if (typeof handler === "function") publicHandlers.add(handler);

    return descriptor;
  }) as MethodDecorator;
}

export function isPublicHandler(handler: unknown): boolean {
  return typeof handler === "function" && publicHandlers.has(handler);
}
