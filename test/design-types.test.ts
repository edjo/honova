import { describe, expect, it } from "vitest";

import {
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  createApp,
  getConstructorParamTypes,
} from "../src/index";

/**
 * Constructor injection by declared TYPE.
 *
 * With `emitDecoratorMetadata` enabled in the consumer's tsconfig, TypeScript
 * emits `design:paramtypes` and a class dependency needs no `@Inject` at all —
 * the module already declares the providers, so the constructor only has to
 * name the type.
 *
 * These tests install the metadata by hand (the same shape the TypeScript
 * helper emits) so the behaviour is verified regardless of how this test file
 * itself was compiled.
 */
const stubEnv = {} as never;
const stubExecutionCtx = { waitUntil(): void {}, passThroughOnException(): void {} } as never;

function declareParamTypes(target: Function, types: unknown[]): void {
  (Reflect as { metadata?: (k: string, v: unknown) => (t: unknown) => void }).metadata?.(
    "design:paramtypes",
    types,
  )(target);
}

describe("design:paramtypes injection", () => {
  it("resolves a class dependency with no @Inject", async () => {
    @Injectable()
    class GreetingService {
      greet(): string {
        return "hello";
      }
    }

    @Controller("/greet")
    class GreetController {
      constructor(private readonly greeting: GreetingService) {}

      @Get("/")
      handle() {
        return { message: this.greeting.greet() };
      }
    }

    declareParamTypes(GreetController, [GreetingService]);

    @Module({ controllers: [GreetController], providers: [GreetingService] })
    class AppModule {}

    const app = createApp();
    app.registerModule(AppModule);

    const response = await app.fetch(new Request("http://local/greet"), stubEnv, stubExecutionCtx);

    await expect(response.json()).resolves.toEqual({ message: "hello" });
  });

  /**
   * The reason this is preferable to parameter-NAME inference: the metadata
   * holds the class binding itself, so a minifier that renames the parameter —
   * or the class — keeps working.
   */
  it("survives a renamed constructor parameter", async () => {
    @Injectable()
    class TokenService {
      value(): string {
        return "token";
      }
    }

    @Controller("/token")
    class TokenController {
      // Named nothing like the provider, which name-based inference requires.
      constructor(private readonly x: TokenService) {}

      @Get("/")
      handle() {
        return { value: this.x.value() };
      }
    }

    declareParamTypes(TokenController, [TokenService]);

    @Module({ controllers: [TokenController], providers: [TokenService] })
    class AppModule {}

    const app = createApp();
    app.registerModule(AppModule);

    const response = await app.fetch(new Request("http://local/token"), stubEnv, stubExecutionCtx);

    await expect(response.json()).resolves.toEqual({ value: "token" });
  });

  /** An explicit @Inject still wins — it is the only way to name a symbol. */
  it("lets @Inject override the declared type", async () => {
    @Injectable()
    class RealService {
      name(): string {
        return "real";
      }
    }

    @Injectable()
    class OverrideService {
      name(): string {
        return "override";
      }
    }

    @Controller("/override")
    class OverrideController {
      constructor(@Inject(OverrideService) private readonly service: RealService) {}

      @Get("/")
      handle() {
        return { name: this.service.name() };
      }
    }

    declareParamTypes(OverrideController, [RealService]);

    @Module({
      controllers: [OverrideController],
      providers: [RealService, OverrideService],
    })
    class AppModule {}

    const app = createApp();
    app.registerModule(AppModule);

    const response = await app.fetch(
      new Request("http://local/override"),
      stubEnv,
      stubExecutionCtx,
    );

    await expect(response.json()).resolves.toEqual({ name: "override" });
  });

  it("ignores primitive parameter types, which are never injectable", () => {
    class WithPrimitives {
      constructor(
        readonly a: string,
        readonly b: number,
      ) {}
    }

    declareParamTypes(WithPrimitives, [String, Number]);

    expect(getConstructorParamTypes(WithPrimitives)).toEqual([undefined, undefined]);
  });

  it("returns nothing when the consumer has not enabled emitDecoratorMetadata", () => {
    class Undecorated {}

    expect(getConstructorParamTypes(Undecorated)).toEqual([]);
  });
});
