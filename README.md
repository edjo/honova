# Honova

Nest-like framework for Cloudflare Workers built on top of Hono.

Honova provides a module system, decorators, dependency injection, route metadata, request-aware lifecycle, and typed database middleware so you can build structured APIs on the edge without bringing a full Node-centric runtime.

## Status

- Package version: `0.0.1`
- Runtime target: Cloudflare Workers (also works anywhere Hono runs)
- Module format: ESM

## Feature Checklist

### Core Framework

- [x] `@Module()` with `controllers`, `providers`, and `imports`
- [x] `@Controller()` with route prefixing
- [x] HTTP method decorators: `@Get`, `@Post`, `@Put`, `@Patch`, `@Delete`, `@Options`, `@Head`
- [x] Dependency Injection container
- [x] `@Injectable()` scopes (`singleton`, `request`, `transient`)
- [x] `@Inject()` token-based constructor injection
- [x] Provider auto-inference by constructor parameter name
- [x] Request-aware provider resolution (`resolveWithContext`)
- [x] `OnModuleInit` lifecycle hook (sync)
- [x] Global middleware registration
- [x] Controller-level and route-level middleware via `@UseMiddleware`
- [x] Built-in `not_found` and `internal_error` JSON responses

### Security and Observability

- [x] CORS integration (`hono/cors`)
- [x] Optional secure headers (`hono/secure-headers`)
- [x] Request ID propagation (`x-request-id` by default)
- [x] Access logs with log level control (`debug`, `info`, `warn`, `error`)
- [x] Header redaction in debug logs

### Authentication Middleware

- [x] Bearer auth middleware (`UseBearerAuth`, `BearerAuth`)
- [x] API key middleware (`UseApiKey`, `ApiKeyAuth`)
- [x] Auth principal injection into context (`c.set("auth", principal)`)
- [x] Overrideable auth error handling

### Database Layer

- [x] `defineDatabase()` typed config helper
- [x] `DatabaseManager` with per-request lifecycle
- [x] Single and multi-connection support
- [x] `defaultConnection` enforcement for multi-DB setups
- [x] URL resolution from static URL, env binding, or async resolver
- [x] Eager connection initialization
- [x] Connection cleanup hooks
- [x] Context bindings: `c.db`, `c.get("db")`, `c.get("dbConnections")`
- [x] Adapter helpers: Drizzle, Prisma, MongoDB (`createMongoDbAdapter`) with legacy alias (`createMondelAdapter`)

### Tests

- [x] DI behavior tests
- [x] Provider validation tests (`@Injectable` required)
- [x] Lifecycle behavior tests (`onModuleInit` with request context)
- [x] Database manager and middleware tests

### Planned / Missing Features

- [x] Request-scoped and transient instance caching semantics validated by tests
- [ ] Async `onModuleInit` support in runtime
- [ ] Validation pipes and DTO validation layer
- [ ] Guard/interceptor abstraction (Nest-style)
- [ ] Exception filter abstraction
- [ ] First-class OpenAPI/Swagger generation
- [ ] CLI scaffolding (`create-honova-app`, generators)
- [ ] Official Cloudflare starter templates (D1, KV, R2 examples)
- [ ] More auth primitives (JWT helper, role/permission guard, session middleware)
- [ ] E2E test suite with Worker runtime integration
- [ ] Benchmark/performance suite and guidance
- [ ] Complete API docs website

## Installation

```bash
npm i @honova/core
```

```bash
pnpm add @honova/core
```

```bash
yarn add @honova/core
```

```bash
bun add @honova/core
```

## Quick Start

```ts
import { Controller, Get, Injectable, Module, createApp } from "@honova/core";

@Injectable()
class HealthService {
  getStatus() {
    return { ok: true };
  }
}

@Controller("/health")
class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get("/")
  handle(): Response {
    return Response.json(this.healthService.getStatus());
  }
}

@Module({
  controllers: [HealthController],
  providers: [HealthService],
})
class AppModule {}

const app = createApp({ basePath: "/api" });
app.registerModule(AppModule);

export default {
  fetch: app.fetch,
};
```

## Core Concepts

### Modules

`@Module()` organizes app boundaries:

- `controllers`: classes that expose HTTP handlers
- `providers`: services managed by the DI container
- `imports`: other modules to compose features

All providers listed in `providers` must have `@Injectable()`.

### Controllers and Routes

`@Controller("/prefix")` defines a route prefix. Route handlers are defined with HTTP decorators.

```ts
@Controller("/users")
class UserController {
  @Get("/")
  list() {
    return Response.json([]);
  }
}
```

### Dependency Injection

Providers are resolved through the container. Constructor dependencies can be resolved by:

- explicit token with `@Inject(token)`
- inferred class token by constructor parameter name

Strict DI mode is enabled by default and throws on unresolved dependencies.

Provider scopes:

- `singleton`: one instance per app container
- `request`: one instance per request context (reused within the same request)
- `transient`: new instance on each resolution

### Lifecycle: `OnModuleInit`

A provider can implement `onModuleInit(context?)`.

Current runtime behavior:

- It runs when the provider is resolved for the first time.
- For singleton providers, it runs once per app instance.
- Request context is passed when the provider is resolved during a request.
- It must be synchronous in `0.0.1`.

## Middleware

### Global Middleware

```ts
const app = createApp({
  globalMiddlewares: [async (c, next) => { await next(); }],
});
```

### Decorator Middleware

```ts
import { Controller, Get, UseMiddleware } from "@honova/core";

const requireHeader = async (c: any, next: any) => {
  if (!c.req.header("x-trace")) {
    return c.json({ error: "missing x-trace" }, 400);
  }
  await next();
};

@UseMiddleware(requireHeader)
@Controller("/demo")
class DemoController {
  @Get("/")
  handle() {
    return Response.json({ ok: true });
  }
}
```

## Security and Observability

Configure at app creation:

```ts
const app = createApp({
  security: {
    cors: { origin: ["https://app.example.com"] },
    secureHeaders: true,
  },
  observability: {
    requestIdHeader: "x-request-id",
    enableAccessLogs: true,
    logLevel: "info",
    redactHeaders: ["authorization", "cookie", "x-api-key"],
  },
});
```

## Authentication

### Bearer Token

```ts
import { Controller, Get, UseBearerAuth } from "@honova/core";

@UseBearerAuth({
  verify: async (token) => (token === "valid-token" ? { id: "user_1" } : null),
})
@Controller("/me")
class MeController {
  @Get("/")
  handle() {
    return Response.json({ ok: true });
  }
}
```

### API Key

```ts
import { Controller, Get, UseApiKey } from "@honova/core";

@UseApiKey({
  header: "x-api-key",
  verify: async (key) => (key === "secret" ? { id: "service_1" } : null),
})
@Controller("/internal")
class InternalController {
  @Get("/")
  handle() {
    return Response.json({ ok: true });
  }
}
```

## Database Integration

### Define Connections

```ts
import { createDbManagerMiddleware, defineDatabase } from "@honova/core";

type Env = { DATABASE_URL: string; ANALYTICS_URL: string };

const database = defineDatabase<Env>()({
  lifecycle: { strategy: "request" }, // default
  defaultConnection: "main",
  connections: [
    {
      connectionName: "main",
      adapter: {
        name: "custom",
        connect: async ({ url }) => ({ url }),
      },
      urlFromEnv: "DATABASE_URL",
      // default connection is always initialized per request
    },
    {
      connectionName: "analytics",
      adapter: {
        name: "custom",
        connect: async ({ url }) => ({ url }),
      },
      urlFromEnv: "ANALYTICS_URL",
      eager: true, // optional; initialize this non-default connection on every request
    },
  ],
});

const app = createApp<Env>({
  database,
});
```

Inside handlers:

- `c.db` points to the default connection and also exposes named connections.
- `c.get("dbConnections")` returns all named connections.
- Non-default connections are lazy by default (`eager: false`).
- `lifecycle.strategy` defaults to `"request"` (cleanup after each request). Use `"manual"` only when you intentionally manage connection lifecycle yourself.

## Cloudflare Workers Deployment

Honova exposes `app.fetch`, so Worker export is direct:

```ts
export default {
  fetch: app.fetch,
};
```

Use your standard Worker workflow with Wrangler:

```bash
npm run build
wrangler deploy
```

## API Surface

Main exports include:

- App/runtime: `createApp`, `Application`
- Decorators: `Module`, `Controller`, `Injectable`, `Inject`, `UseMiddleware`, HTTP method decorators
- DI helper: `inject`
- Database: `defineDatabase`, `DatabaseManager`, `createDbManagerMiddleware`, `createDrizzleAdapter`, `createPrismaAdapter`, `createMongoDbAdapter` (legacy `createMondelAdapter`), helpers from `database/types`
- Auth middleware: `UseBearerAuth`, `BearerAuth`, `UseApiKey`, `ApiKeyAuth`

## Development Scripts

```bash
npm run typecheck
npm run test
npm run build
```

## Publish Checklist (npm)

- [x] Version set to `0.0.1`
- [x] ESM build output in `dist/`
- [x] Type declarations emitted
- [x] Package `files` restricted to `dist`
- [x] `prepublishOnly` runs typecheck + tests + build
- [ ] npm organization metadata (`repository`, `bugs`, `homepage`) if needed
- [ ] `npm publish --access public`

## License

MIT
