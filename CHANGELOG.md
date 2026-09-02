# Changelog

## 0.1.0 — 2026-08-25

The "Nest pipeline for Workers" release: guards, interceptors, exception
filters, schema validation, custom providers, async lifecycle, testing module,
JWT auth, and Cron Trigger dispatch — with zero new runtime dependencies.

### Breaking

- **CORS is now opt-in.** `createApp()` no longer applies permissive CORS to
  every app. Pass `security: { cors: true }` (hono defaults) or a config
  object to restore it.
- **`hono` moved from `dependencies` to `peerDependencies`** with the range
  `>=4.13.0 <5`. A wrapper must share the app's single hono instance
  (`instanceof Context` identity, security-patch control stays with the app).
  The floor excludes the `hono/cors` preflight ReDoS fixed in 4.12.34
  (GHSA-8j4g-w8fx-2239) and relies on 4.13 registration-time route errors.
- **`inject()` now resolves from the active application container** instead of
  a detached global singleton. Previously it could never see providers
  registered through `createApp().registerModule(...)`.
- **Scope bubbling.** A singleton consuming a request-scoped provider is now
  itself request-scoped (transitively), matching Nest. Previously the first
  request's instance of a request-scoped dependency was frozen inside singleton
  consumers and served to every later request.

### Added

- **Exception layer**: `HttpException` + 16 typed subclasses
  (`NotFoundException`, `UnauthorizedException`, …), `ValidationException`
  with flattened issues, `@Catch()` / `@UseFilters()` exception filters at
  route/controller/global level, default JSON envelope mapping.
- **Guards**: `CanActivate`, `@UseGuards()` (route/controller), global guards
  via `createApp({ guards })`, DI-resolved guard classes or plain instances.
- **Interceptors (RxJS-free)**: `HonovaInterceptor` — an async onion
  (`intercept(ctx, next)` where `next()` returns the handler result), with
  Nest's FILO ordering. `@UseInterceptors()` + global interceptors.
- **ExecutionContext**: `getClass()`, `getHandler()`, `getContext()` (Hono),
  `env`, `executionCtx` (Workers `waitUntil`) — the argument to every guard,
  interceptor, and filter.
- **Metadata API**: `createDecorator<T>()` + `Reflector`
  (`get`, `getAllAndOverride`, `getAllAndMerge`) over the WeakMap store —
  no reflect-metadata, works in legacy and TC39 stage-3 decorator modes.
- **Validation via Standard Schema v1**: `@Validate({ body, query, params,
  headers })` accepts any spec-compliant schema (zod >= 3.24, valibot,
  arktype) with no library dependency; typed access through `getInput(c)`;
  failures map to 400 `validation_failed` with per-field issues.
- **Response shaping**: handlers may return plain values (object → JSON,
  string → text, null/undefined → 204, `Response` passes through), plus
  `@HttpCode()` and `@Header()`.
- **Custom providers**: `{ provide, useValue | useFactory | useClass |
  useExisting }` in `@Module({ providers })`, factory `inject` arrays, and
  **async factories** resolved through the request pipeline
  (`container.resolveAsync`).
- **Async `onModuleInit`** — awaited by the request pipeline with
  single-flight semantics per isolate; sync resolution paths still reject
  async inits explicitly.
- **Stage-3 DI**: `@Inject(token)` now also works as a field/accessor
  decorator (TC39 mode has no parameter decorators), plus `static inject =
  [tokens]` for constructor injection without decorators.
- **Env config**: `createApp({ config: { schema } })` validates env bindings
  once per isolate (Standard Schema) and provides the parsed value under the
  `CONFIG` token.
- **JWT auth**: `createJwtGuard({ secret | secretFromEnv, principal })` on
  hono's built-in WebCrypto JWT, failing closed when the secret is missing;
  `@Roles([...])` + `RolesGuard`.
- **Scheduling**: `@Cron("*/5 * * * *")` on provider methods +
  `createScheduledDispatcher(app)` producing the Worker `scheduled()` handler
  (Cloudflare Cron Triggers — no in-process timers), with error isolation
  per job.
- **Standalone context**: `createApplicationContext([Modules])` — the DI
  container without HTTP, for `scheduled()`/`queue()` handlers.
- **Testing module**: `createTestingModule({ controllers, providers })`
  with `overrideProvider(token).useValue/useClass/useFactory`, `request(path,
  { json })` straight through `app.fetch` (no server), and
  `flushWaitUntil()`.
- **HTTP QUERY verb** (`@HttpQuery`, RFC 10008, hono >= 4.13) and
  `methodNotAllowed: true` option (405 + `Allow` via hono middleware).
- Route-registration failures (hono 4.13 `UnsupportedPathError`) are reported
  with the controller and route named.

### Fixed (adversarial review — 10 confirmed findings)

An independent multi-lens review (Workers runtime, Nest parity, security) with
adversarial verification confirmed and led to these fixes:

- **Rejected async singleton promises no longer poison the isolate** — a
  transient factory/init failure was cached forever; now evicted on rejection
  so the next request retries.
- **Request-scoped async providers get per-request single-flight** — two
  concurrent resolutions inside one request produced duplicate instances.
- **Resolution context is removed by identity and never held across `await`**
  — concurrent requests could pop each other's contexts and leak
  request-scoped instances between requests.
- **Scope bubbling now sees out-of-band resolutions** — `inject()` called
  synchronously inside a factory or constructor contributes its scope, so
  request-scoped dependencies can no longer be frozen into singletons through
  the side door.
- **Routes, guards, interceptors, and filters are inherited** from decorated
  base controller classes (prototype/constructor-chain walk, child-most route
  wins, base-first enhancers).
- **`@UseMiddleware` written below the HTTP method decorator is no longer
  silently dropped** (decorator evaluation order); class-level middleware now
  runs in declaration order.
- **Observability header write uses `c.header()`** — setting on an immutable
  proxied `fetch()` Response threw a 500 for the whole request.
- **`ensureConfig(env)` is public** and the scheduled dispatcher calls it, so
  `@Cron` handlers can depend on `CONFIG` (previously only the HTTP
  middleware registered it).
- **5xx exception bodies are opaque to clients** — messages/details for
  status >= 500 are logged, not returned. 4xx keep their messages.
- **JWT guard hardening**: tokens without `exp` are rejected by default
  (`requireExp: false` to opt out); optional `issuer`/`audience` binding;
  client-supplied `x-request-id` is sanitized before being echoed; custom
  `redactHeaders` extend the defaults instead of replacing them; binary and
  stream handler results bypass JSON serialization; `ClassProvider` accepts a
  `scope` override.

### Known divergences (documented, intentional)

- `Container.setActive` is last-application-wins within one isolate; apps
  should not share an isolate with conflicting `inject()` usage — prefer
  constructor injection, which always uses the app's own container.
- Serialized responses default to 200 for every method (Nest defaults POST
  to 201) — use `@HttpCode(201)` explicitly.

### Notes

- Constructor param-name inference remains a convenience for unbundled code;
  it breaks under minification. Explicit tokens (`@Inject`, `static inject`)
  are the supported path.
- Singletons are **per isolate** on Workers: shared across requests in one
  isolate, not across colos. Request-scoped providers are the only
  per-request guarantee.
