import { describe, expect, it } from "vitest";

import {
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  createApp,
  createTestingModule,
  inject,
} from "../src/index";

describe("custom providers in @Module providers", () => {
  it("resolves a useValue provider to the exact value", () => {
    const configValue = { name: "honova", retries: 3 };

    const moduleRef = createTestingModule({
      providers: [{ provide: "CONFIG_OBJ", useValue: configValue }],
    }).compile();

    expect(moduleRef.container.resolve("CONFIG_OBJ")).toBe(configValue);
  });

  it("resolves a useClass provider to an instance of the given class", () => {
    class ManualImpl {
      who = "manual";
    }

    const moduleRef = createTestingModule({
      providers: [{ provide: "MANUAL", useClass: ManualImpl }],
    }).compile();

    const resolved = moduleRef.container.resolve<ManualImpl>("MANUAL");
    expect(resolved).toBeInstanceOf(ManualImpl);
    expect(resolved.who).toBe("manual");
    // Singleton by default: same instance on the second resolve.
    expect(moduleRef.container.resolve("MANUAL")).toBe(resolved);
  });

  it("resolves a useExisting alias to the same instance as the target token", () => {
    @Injectable()
    class BaseService {
      who = "base";
    }

    const moduleRef = createTestingModule({
      providers: [BaseService, { provide: "BASE_ALIAS", useExisting: BaseService }],
    }).compile();

    const viaAlias = moduleRef.container.resolve<BaseService>("BASE_ALIAS");
    const viaClass = moduleRef.container.resolve(BaseService);

    expect(viaAlias).toBeInstanceOf(BaseService);
    expect(viaAlias).toBe(viaClass);
  });

  it("passes resolved inject tokens to a useFactory provider", () => {
    const configValue = { name: "honova" };
    const received: unknown[] = [];

    const moduleRef = createTestingModule({
      providers: [
        { provide: "CONFIG_OBJ", useValue: configValue },
        {
          provide: "GREETING",
          useFactory: (config: { name: string }) => {
            received.push(config);
            return `hello ${config.name}`;
          },
          inject: ["CONFIG_OBJ"],
        },
      ],
    }).compile();

    expect(moduleRef.container.resolve("GREETING")).toBe("hello honova");
    expect(received).toEqual([configValue]);
    expect(received[0]).toBe(configValue);
  });
});

describe("async useFactory", () => {
  it("serves HTTP requests via resolveAsync while sync resolve throws before settling", async () => {
    @Controller("/async-dep")
    class AsyncDepController {
      constructor(@Inject("ASYNC_DEP") private readonly dep: { ready: boolean }) {}

      @Get("/")
      handle(): Response {
        return Response.json({ ready: this.dep.ready });
      }
    }

    const moduleRef = createTestingModule({
      controllers: [AsyncDepController],
      providers: [
        {
          provide: "ASYNC_DEP",
          useFactory: async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            return { ready: true };
          },
        },
      ],
    }).compile();

    // Before the async factory has settled, synchronous resolution must fail
    // loudly instead of handing out a Promise.
    expect(() => moduleRef.container.resolve("ASYNC_DEP")).toThrowError(
      /resolves asynchronously/,
    );

    const response = await moduleRef.request("/async-dep");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ready: true });
  });
});

describe("async onModuleInit", () => {
  it("is awaited before the first handler runs and runs exactly once across requests", async () => {
    let initCount = 0;

    @Injectable()
    class WarmupService {
      ready = false;

      async onModuleInit(): Promise<void> {
        initCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        this.ready = true;
      }
    }

    @Controller("/warmup")
    class WarmupController {
      constructor(private readonly warmupService: WarmupService) {}

      @Get("/")
      handle(): Response {
        return Response.json({ ready: this.warmupService.ready, initCount });
      }
    }

    const moduleRef = createTestingModule({
      controllers: [WarmupController],
      providers: [WarmupService],
    }).compile();

    const first = await moduleRef.request("/warmup");
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ready: true, initCount: 1 });

    const second = await moduleRef.request("/warmup");
    expect(await second.json()).toEqual({ ready: true, initCount: 1 });
  });
});

describe("request scope bubbling", () => {
  it("gives each request a fresh request-scoped dep through a default-scope controller", async () => {
    let instanceCounter = 0;

    @Injectable({ scope: "request" })
    class RequestTracker {
      readonly instanceId = ++instanceCounter;
    }

    @Controller("/tracked")
    class TrackedController {
      constructor(private readonly requestTracker: RequestTracker) {}

      @Get("/")
      handle(): Response {
        return Response.json({ instanceId: this.requestTracker.instanceId });
      }
    }

    const moduleRef = createTestingModule({
      controllers: [TrackedController],
      providers: [RequestTracker],
    }).compile();

    const first = (await (await moduleRef.request("/tracked")).json()) as {
      instanceId: number;
    };
    const second = (await (await moduleRef.request("/tracked")).json()) as {
      instanceId: number;
    };

    expect(first.instanceId).not.toBe(second.instanceId);
  });

  it("keeps a singleton service without request deps stable across requests", async () => {
    let instanceCounter = 0;

    @Injectable()
    class StableService {
      readonly instanceId = ++instanceCounter;
    }

    @Controller("/stable")
    class StableController {
      constructor(private readonly stableService: StableService) {}

      @Get("/")
      handle(): Response {
        return Response.json({ instanceId: this.stableService.instanceId });
      }
    }

    const moduleRef = createTestingModule({
      controllers: [StableController],
      providers: [StableService],
    }).compile();

    const first = (await (await moduleRef.request("/stable")).json()) as {
      instanceId: number;
    };
    const second = (await (await moduleRef.request("/stable")).json()) as {
      instanceId: number;
    };

    expect(first.instanceId).toBe(second.instanceId);
    expect(instanceCounter).toBe(1);
  });
});

describe("static inject", () => {
  it("matches static inject tokens to constructor params positionally", () => {
    @Injectable()
    class PairService {
      static inject = ["FIRST_TOKEN", "SECOND_TOKEN"];

      constructor(
        readonly first: string,
        readonly second: string,
      ) {}
    }

    const moduleRef = createTestingModule({
      providers: [
        PairService,
        { provide: "FIRST_TOKEN", useValue: "alpha" },
        { provide: "SECOND_TOKEN", useValue: "beta" },
      ],
    }).compile();

    const pair = moduleRef.container.resolve(PairService);
    expect(pair.first).toBe("alpha");
    expect(pair.second).toBe("beta");
  });
});

describe("inject() helper", () => {
  it("resolves from the active application container after registerModule", () => {
    @Injectable()
    class ActiveService {
      readonly marker = "active";
    }

    @Module({ providers: [ActiveService] })
    class ActiveModule {}

    const app = createApp().registerModule(ActiveModule);

    const viaHelper = inject(ActiveService);
    const viaContainer = app.getContainer().resolve(ActiveService);

    expect(viaHelper).toBeInstanceOf(ActiveService);
    expect(viaHelper).toBe(viaContainer);
  });

  it("throws a registration hint for providers the active app never registered", () => {
    @Injectable()
    class NeverRegisteredService {}

    @Injectable()
    class SomeService {}

    @Module({ providers: [SomeService] })
    class SomeModule {}

    createApp().registerModule(SomeModule);

    expect(() => inject(NeverRegisteredService)).toThrowError(/is not registered/);
  });
});

describe("transient scope", () => {
  it("does not bubble: a singleton consumer stays singleton across requests", async () => {
    let transientCounter = 0;
    let controllerCounter = 0;

    @Injectable({ scope: "transient" })
    class TransientDep {
      readonly instanceId = ++transientCounter;
    }

    @Controller("/transient")
    class TransientConsumerController {
      readonly controllerId = ++controllerCounter;

      constructor(private readonly transientDep: TransientDep) {}

      @Get("/")
      handle(): Response {
        return Response.json({
          controllerId: this.controllerId,
          depId: this.transientDep.instanceId,
        });
      }
    }

    const moduleRef = createTestingModule({
      controllers: [TransientConsumerController],
      providers: [TransientDep],
    }).compile();

    const first = (await (await moduleRef.request("/transient")).json()) as {
      controllerId: number;
      depId: number;
    };
    const second = (await (await moduleRef.request("/transient")).json()) as {
      controllerId: number;
      depId: number;
    };

    // Same singleton controller, therefore the same captured transient dep.
    expect(first.controllerId).toBe(second.controllerId);
    expect(first.depId).toBe(second.depId);

    // Direct resolution still hands out a fresh transient every time.
    const a = moduleRef.container.resolve(TransientDep);
    const b = moduleRef.container.resolve(TransientDep);
    expect(a.instanceId).not.toBe(b.instanceId);
  });
});
