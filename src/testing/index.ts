import { Application, type ApplicationOptions } from "../core/application.js";
import { Container } from "../core/container/container.js";
import { setModuleMetadata } from "../core/metadata.js";
import type { Constructor, ModuleMetadata, Token } from "../core/types.js";

/**
 * Nest's Test.createTestingModule, sized for Workers: "e2e" needs no server —
 * requests go straight through app.fetch with a stub env and ExecutionContext,
 * which is exactly how workerd invokes the app in production.
 */

export interface TestingMetadata extends ModuleMetadata {
  /** Existing @Module classes to register alongside inline metadata. */
  imports?: Constructor[];
}

export interface TestRequestInit extends RequestInit {
  /** JSON convenience: sets the body and content-type. */
  json?: unknown;
}

export interface TestApp<Env extends Record<string, unknown> = Record<string, unknown>> {
  app: Application<Env>;
  container: Container;
  request(path: string, init?: TestRequestInit, env?: Env): Promise<Response>;
  resolve<T>(token: Constructor<T> | string | symbol): Promise<T>;
  /** Awaits everything handlers scheduled via executionCtx.waitUntil. */
  flushWaitUntil(): Promise<void>;
}

interface Override {
  token: Token;
  provider:
    | { useValue: unknown }
    | { useClass: Constructor }
    | { useFactory: (...deps: never[]) => unknown; inject?: Token[] };
}

export class TestingModuleBuilder<Env extends Record<string, unknown> = Record<string, unknown>> {
  private readonly overrides: Override[] = [];

  constructor(
    private readonly metadata: TestingMetadata,
    private readonly options: ApplicationOptions<Env> = {},
  ) {}

  overrideProvider(token: Token): {
    useValue: (value: unknown) => TestingModuleBuilder<Env>;
    useClass: (target: Constructor) => TestingModuleBuilder<Env>;
    useFactory: (
      factory: (...deps: never[]) => unknown,
      inject?: Token[],
    ) => TestingModuleBuilder<Env>;
  } {
    return {
      useValue: (value) => {
        this.overrides.push({ token, provider: { useValue: value } });
        return this;
      },
      useClass: (target) => {
        this.overrides.push({ token, provider: { useClass: target } });
        return this;
      },
      useFactory: (factory, inject) => {
        this.overrides.push({ token, provider: { useFactory: factory, inject } });
        return this;
      },
    };
  }

  compile(): TestApp<Env> {
    const app = new Application<Env>(this.options);

    if (this.metadata.controllers?.length || this.metadata.providers?.length) {
      class InlineTestModule {}
      setModuleMetadata(InlineTestModule, {
        controllers: this.metadata.controllers ?? [],
        providers: this.metadata.providers ?? [],
      });
      app.registerModule(InlineTestModule as Constructor);
    }

    for (const imported of this.metadata.imports ?? []) {
      app.registerModule(imported);
    }

    // Overrides land after module registration; resolution is lazy, so no
    // instance has been constructed from the original provider yet.
    const container = app.getContainer();
    for (const override of this.overrides) {
      container.registerProvider({ provide: override.token, ...override.provider } as never);
    }

    const waitUntilPromises: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil(promise: Promise<unknown>): void {
        waitUntilPromises.push(promise);
      },
      passThroughOnException(): void {},
    };

    return {
      app,
      container,
      request: async (path, init = {}, env) => {
        const { json, ...requestInit } = init;
        if (json !== undefined) {
          requestInit.body = JSON.stringify(json);
          requestInit.headers = {
            "content-type": "application/json",
            ...(requestInit.headers as Record<string, string> | undefined),
          };
        }

        const url = path.startsWith("http") ? path : `http://testing.local${path}`;
        return app.fetch(new Request(url, requestInit), env ?? ({} as Env), executionCtx);
      },
      resolve: (token) => container.resolveAsync(token),
      flushWaitUntil: async () => {
        await Promise.all(waitUntilPromises.splice(0));
      },
    };
  }
}

export function createTestingModule<Env extends Record<string, unknown> = Record<string, unknown>>(
  metadata: TestingMetadata,
  options: ApplicationOptions<Env> = {},
): TestingModuleBuilder<Env> {
  return new TestingModuleBuilder(metadata, options);
}
