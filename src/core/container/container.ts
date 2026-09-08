import { getConstructorParamTypes } from "../design-types.js";
import { getInjectableMetadata, getInjectionTokens } from "../metadata.js";
import type {
  Constructor,
  CustomProvider,
  InjectionScope,
  OnModuleInit,
  ProviderDefinition,
  Token,
} from "../types.js";

interface ContainerConfig {
  strict: boolean;
  /** See `ApplicationOptions.di.inferByParamName`. */
  inferByParamName: boolean;
}

const warned = new Set<string>();

function warnOnce(message: string): void {
  if (warned.has(message)) return;

  warned.add(message);
  console.warn(message);
}

const defaultConfig: ContainerConfig = {
  strict: true,
  inferByParamName: true,
};

interface ProviderRecord {
  kind: "class" | "value" | "factory" | "alias" | "legacy-factory";
  scope: InjectionScope;
  target?: Constructor;
  value?: unknown;
  factory?: (...deps: unknown[]) => unknown;
  injectTokens?: Token[];
  aliasOf?: Token;
}

interface Resolution<T> {
  instance: T;
  scope: InjectionScope;
}

function isCustomProvider(definition: ProviderDefinition): definition is CustomProvider {
  return typeof definition === "object" && definition !== null && "provide" in definition;
}

export class Container {
  private static instance: Container;
  private static active: Container | undefined;

  private readonly records = new Map<Token, ProviderRecord>();
  private readonly singletons = new Map<Token, unknown>();
  private readonly singletonPromises = new Map<Token, Promise<unknown>>();
  private readonly effectiveScopes = new Map<Token, InjectionScope>();
  private readonly requestScopedInstances = new WeakMap<object, Map<Token, unknown>>();
  private readonly requestScopedPromises = new WeakMap<object, Map<Token, Promise<unknown>>>();
  private readonly resolving = new Set<Token>();
  /**
   * Open dependency-collection frames. Every resolution reports its effective
   * scope into the innermost frame, so even out-of-band resolutions (inject()
   * called synchronously inside a factory or constructor) participate in
   * scope bubbling instead of silently freezing request-scoped instances
   * into singleton consumers.
   */
  private readonly scopeFrames: InjectionScope[][] = [];
  private readonly initialized = new WeakSet<object>();
  private readonly resolutionContextStack: unknown[] = [];
  private config: ContainerConfig = { ...defaultConfig };

  static getInstance(): Container {
    if (!Container.instance) {
      Container.instance = new Container();
    }

    return Container.instance;
  }

  static reset(): void {
    Container.instance = new Container();
    Container.active = undefined;
  }

  /**
   * The container of the most recently created Application (or testing
   * module). `inject()` resolves against this, so the helper sees the same
   * providers the app registered instead of the detached global singleton.
   */
  static setActive(container: Container): void {
    Container.active = container;
  }

  static getActive(): Container {
    return Container.active ?? Container.getInstance();
  }

  configure(config: Partial<ContainerConfig>): void {
    this.config = {
      ...this.config,
      ...config,
    };
  }

  register<T>(token: Constructor<T> | string | symbol, factory?: () => T): void {
    if (factory) {
      this.records.set(token, { kind: "legacy-factory", scope: "singleton", factory });
      return;
    }

    if (typeof token === "function") {
      this.records.set(token, {
        kind: "class",
        scope: getInjectableMetadata(token)?.scope ?? "singleton",
        target: token,
      });
    }
  }

  registerProvider(definition: ProviderDefinition): void {
    if (!isCustomProvider(definition)) {
      this.register(definition);
      return;
    }

    if ("useValue" in definition) {
      this.records.set(definition.provide, {
        kind: "value",
        scope: "singleton",
        value: definition.useValue,
      });
      return;
    }

    if ("useFactory" in definition) {
      this.records.set(definition.provide, {
        kind: "factory",
        scope: definition.scope ?? "singleton",
        factory: definition.useFactory as (...deps: unknown[]) => unknown,
        injectTokens: definition.inject ?? [],
      });
      return;
    }

    if ("useClass" in definition) {
      this.records.set(definition.provide, {
        kind: "class",
        scope:
          definition.scope ??
          getInjectableMetadata(definition.useClass)?.scope ??
          "singleton",
        target: definition.useClass,
      });
      return;
    }

    this.records.set(definition.provide, {
      kind: "alias",
      scope: "singleton",
      aliasOf: definition.useExisting,
    });
  }

  has(token: Token): boolean {
    return this.singletons.has(token) || this.records.has(token);
  }

  /**
   * Synchronous resolution. Kept for helpers and tests; throws when it meets
   * an async factory or async onModuleInit — the request pipeline uses
   * resolveAsync, which awaits both.
   */
  resolve<T>(token: Constructor<T> | string | symbol): T {
    return this.resolveInternal<T>(token, false).instance;
  }

  async resolveAsync<T>(token: Constructor<T> | string | symbol): Promise<T> {
    const resolution = this.resolveInternal<T | Promise<T>>(token, true);
    return await resolution.instance;
  }

  resolveWithContext<T>(token: Constructor<T> | string | symbol, context: unknown): T {
    this.resolutionContextStack.push(context);
    try {
      return this.resolve(token);
    } finally {
      this.removeContext(context);
    }
  }

  async resolveWithContextAsync<T>(
    token: Constructor<T> | string | symbol,
    context: unknown,
  ): Promise<T> {
    // resolveInternal is fully synchronous (it may return a promise-valued
    // instance, but builds it synchronously), so the ambient context never
    // has to survive an await: push, resolve, remove, then settle. Holding it
    // across the await let concurrent requests pop each other's contexts.
    this.resolutionContextStack.push(context);
    let resolution: Resolution<T | Promise<T>>;
    try {
      resolution = this.resolveInternal<T | Promise<T>>(token, true);
    } finally {
      this.removeContext(context);
    }

    return await resolution.instance;
  }

  /** Remove by identity: concurrent requests must never pop someone else's context. */
  private removeContext(context: unknown): void {
    const index = this.resolutionContextStack.lastIndexOf(context);
    if (index >= 0) {
      this.resolutionContextStack.splice(index, 1);
    }
  }

  private resolveInternal<T>(token: Token, allowAsync: boolean): Resolution<T> {
    const resolution = this.resolveInternalUnreported<T>(token, allowAsync);
    const frame = this.scopeFrames[this.scopeFrames.length - 1];
    if (frame) {
      frame.push(resolution.scope);
    }

    return resolution;
  }

  private resolveInternalUnreported<T>(token: Token, allowAsync: boolean): Resolution<T> {
    if (this.singletons.has(token)) {
      return { instance: this.singletons.get(token) as T, scope: "singleton" };
    }

    if (allowAsync && this.singletonPromises.has(token)) {
      return { instance: this.singletonPromises.get(token) as T, scope: "singleton" };
    }

    const knownScope = this.effectiveScopes.get(token);
    if (knownScope === "request") {
      const cached = this.getRequestScopedInstance<T>(token);
      if (cached !== undefined) {
        return { instance: cached, scope: "request" };
      }

      if (allowAsync) {
        const pending = this.getRequestScopedPromise<T>(token);
        if (pending !== undefined) {
          return { instance: pending as T, scope: "request" };
        }
      }
    }

    const record = this.records.get(token);
    if (!record) {
      throw new Error(`No provider found for token: ${String(token)}`);
    }

    if (record.kind === "value") {
      this.singletons.set(token, record.value);
      this.effectiveScopes.set(token, "singleton");
      return { instance: record.value as T, scope: "singleton" };
    }

    if (record.kind === "alias") {
      const resolution = this.resolveInternal<T>(record.aliasOf as Token, allowAsync);
      this.effectiveScopes.set(token, resolution.scope);
      return resolution;
    }

    if (this.resolving.has(token)) {
      throw new Error(`Circular dependency detected for token: ${String(token)}`);
    }

    this.resolving.add(token);
    this.scopeFrames.push([]);
    let created: { instance: T; depScopes: InjectionScope[] };
    let collectedScopes: InjectionScope[];
    try {
      created = this.instantiate<T>(record, allowAsync);
    } finally {
      collectedScopes = this.scopeFrames.pop() ?? [];
    }

    try {
      const effectiveScope = this.bubbleScope(record.scope, [
        ...created.depScopes,
        ...collectedScopes,
      ]);
      this.effectiveScopes.set(token, effectiveScope);

      const instance = created.instance;

      if (!allowAsync) {
        this.assertSyncResult(token, instance);
        this.runSyncInit(instance);
        this.cacheByScope(token, effectiveScope, instance);
        return { instance, scope: effectiveScope };
      }

      // The resolution-context stack unwinds before promises settle, so
      // capture the request context now for init and caching inside .then.
      const contextSnapshot = this.getCurrentContextObject();

      const commit = (settled: unknown): void => {
        if (effectiveScope === "singleton") {
          this.singletons.set(token, settled);
          this.singletonPromises.delete(token);
          return;
        }

        this.cacheByScopeWithContext(token, effectiveScope, settled, contextSnapshot);
      };

      if (this.isThenable(instance)) {
        // Single-flight: concurrent first requests share one settling promise.
        const settling = (instance as Promise<T>).then(async (settled) => {
          const init = this.invokeInit(settled, contextSnapshot);
          if (this.isThenable(init)) {
            await init;
          }
          commit(settled);
          return settled;
        });

        this.trackSettling(token, effectiveScope, settling, contextSnapshot);
        return { instance: settling as T, scope: effectiveScope };
      }

      const initResult = this.invokeInit(instance, contextSnapshot);
      if (this.isThenable(initResult)) {
        const settling = (initResult as Promise<unknown>).then(() => {
          commit(instance);
          return instance as T;
        });

        this.trackSettling(token, effectiveScope, settling as Promise<T>, contextSnapshot);
        return { instance: settling as T, scope: effectiveScope };
      }

      this.cacheByScope(token, effectiveScope, instance);
      return { instance, scope: effectiveScope };
    } finally {
      this.resolving.delete(token);
    }
  }

  /**
   * Tracks an in-flight async resolution so concurrent resolutions share it,
   * and evicts it on rejection: a cached rejected promise would otherwise
   * poison the isolate — every later request replaying one transient failure.
   */
  private trackSettling<T>(
    token: Token,
    scope: InjectionScope,
    settling: Promise<T>,
    context: object | undefined,
  ): void {
    if (scope === "singleton") {
      this.singletonPromises.set(token, settling);
      settling.catch(() => {
        if (this.singletonPromises.get(token) === settling) {
          this.singletonPromises.delete(token);
        }
      });
      return;
    }

    if (scope !== "request" || !context) {
      return;
    }

    const byToken = this.requestScopedPromises.get(context) ?? new Map<Token, Promise<unknown>>();
    byToken.set(token, settling);
    this.requestScopedPromises.set(context, byToken);
    settling.catch(() => {
      if (byToken.get(token) === settling) {
        byToken.delete(token);
      }
    });
  }

  private getRequestScopedPromise<T>(token: Token): Promise<T> | undefined {
    const context = this.getCurrentContextObject();
    if (!context) {
      return undefined;
    }

    return this.requestScopedPromises.get(context)?.get(token) as Promise<T> | undefined;
  }

  private instantiate<T>(
    record: ProviderRecord,
    allowAsync: boolean,
  ): { instance: T; depScopes: InjectionScope[] } {
    if (record.kind === "legacy-factory") {
      return { instance: record.factory!() as T, depScopes: [] };
    }

    if (record.kind === "factory") {
      const depScopes: InjectionScope[] = [];
      const deps = (record.injectTokens ?? []).map((depToken) => {
        const resolution = this.resolveInternal<unknown>(depToken, allowAsync);
        depScopes.push(resolution.scope);
        return resolution.instance;
      });

      if (deps.some((dep) => this.isThenable(dep))) {
        const instance = Promise.all(deps).then((settled) => record.factory!(...settled));
        return { instance: instance as T, depScopes };
      }

      return { instance: record.factory!(...deps) as T, depScopes };
    }

    return this.createClassInstance<T>(record.target as Constructor<T>, allowAsync);
  }

  private createClassInstance<T>(
    target: Constructor<T>,
    allowAsync: boolean,
  ): { instance: T; depScopes: InjectionScope[] } {
    const injections = getInjectionTokens(target);
    const staticInject = this.getStaticInjectTokens(target);
    // Resolution order, strongest signal first:
    //   1. @Inject(token)          — explicit, and the only way to name a
    //                                non-class token such as a symbol
    //   2. static inject = [...]   — explicit, for consumers avoiding decorators
    //   3. design:paramtypes       — the declared parameter TYPE, emitted by
    //                                TypeScript's emitDecoratorMetadata. Safe
    //                                under minification: it references the class
    //                                binding, not an identifier name.
    //   4. parameter name          — legacy fallback, kept for consumers without
    //                                emitDecoratorMetadata. Fragile under
    //                                minification; prefer any of the above.
    const declaredTypes = getConstructorParamTypes(target);
    const inferredDependencies = this.config.inferByParamName
      ? this.inferDependenciesByParamName(target)
      : [];


    const paramCount = Math.max(
      target.length,
      injections.size > 0 ? Math.max(...injections.keys()) + 1 : 0,
      staticInject.length,
      declaredTypes.length,
      inferredDependencies.length,
    );

    const depScopes: InjectionScope[] = [];
    const deps: unknown[] = [];
    for (let index = 0; index < paramCount; index += 1) {
      const explicitToken = injections.get(index) ?? staticInject[index] ?? declaredTypes[index];
      const token = explicitToken ?? inferredDependencies[index];

      // Resolving by parameter name works in development and breaks in a
      // minified bundle, and it also masks a genuinely missing token — a
      // type-only import (`import { type Foo }`) is erased at runtime, emits no
      // metadata, and would otherwise appear to work. Say so, loudly.
      if (!explicitToken && token) {
        warnOnce(
          `honova: resolved dependency #${index} of ${target.name} by parameter name. ` +
            "This breaks under minification. Declare `static inject = [...]` on the class, " +
            "or use @Inject(token). Note that emitDecoratorMetadata alone is NOT enough " +
            "for a Cloudflare Worker: wrangler bundles with esbuild, which does not emit " +
            "decorator metadata, so a build that works under Vite or tsc can still fail " +
            "once deployed.",
        );
      }

      if (!token) {
        if (this.config.strict) {
          throw new Error(
            `Cannot resolve dependency #${index} of ${target.name}. ` +
              "Name the token explicitly with a `static inject = [...]` array or " +
              "@Inject(token). Inference from `design:paramtypes` is available only " +
              "when the bundler emits decorator metadata: tsc and Vite do, esbuild " +
              "does NOT, so a Cloudflare Worker bundled by wrangler must declare its " +
              "tokens. The other common cause is a type-only import: " +
              "`import { type Foo }` is erased at runtime and emits no metadata.",
          );
        }

        deps.push(undefined);
        continue;
      }

      const resolution = this.resolveInternal<unknown>(token, allowAsync);
      depScopes.push(resolution.scope);
      deps.push(resolution.instance);
    }

    const InstantiableTarget = target as unknown as new (...args: unknown[]) => T;

    if (deps.some((dep) => this.isThenable(dep))) {
      const instance = Promise.all(deps).then(
        (settled) => new InstantiableTarget(...settled),
      );
      return { instance: instance as T, depScopes };
    }

    return { instance: new InstantiableTarget(...deps), depScopes };
  }

  /**
   * Nest's scope bubbling: a consumer of a request-scoped provider becomes
   * request-scoped itself, transitively. Without this, a singleton controller
   * would freeze its request-scoped dependencies from the first request and
   * serve them to every later one. Transient does not bubble.
   */
  private bubbleScope(own: InjectionScope, depScopes: InjectionScope[]): InjectionScope {
    if (own === "transient") {
      return "transient";
    }

    if (own === "request") {
      return "request";
    }

    return depScopes.includes("request") ? "request" : "singleton";
  }

  private assertSyncResult(token: Token, instance: unknown): void {
    if (this.isThenable(instance)) {
      throw new Error(
        `Provider ${String(token)} resolves asynchronously. Use resolveAsync() ` +
          "(the request pipeline does) or make the factory synchronous.",
      );
    }
  }

  private runSyncInit(instance: unknown): void {
    const result = this.invokeInit(instance);
    if (this.isThenable(result)) {
      throw new Error(
        "onModuleInit returned a Promise during synchronous resolution. " +
          "Resolve this provider through the request pipeline or resolveAsync().",
      );
    }
  }

  private invokeInit(instance: unknown, explicitContext?: unknown): unknown {
    if (!instance || typeof instance !== "object") {
      return undefined;
    }

    if (this.initialized.has(instance)) {
      return undefined;
    }

    const maybeLifecycle = instance as Partial<OnModuleInit>;
    if (typeof maybeLifecycle.onModuleInit !== "function") {
      return undefined;
    }

    this.initialized.add(instance);
    const context =
      explicitContext ?? this.resolutionContextStack[this.resolutionContextStack.length - 1];
    return maybeLifecycle.onModuleInit.call(instance, context);
  }

  private isThenable(value: unknown): value is Promise<unknown> {
    return (
      value !== null &&
      value !== undefined &&
      (typeof value === "object" || typeof value === "function") &&
      typeof (value as Promise<unknown>).then === "function"
    );
  }

  private cacheByScope<T>(token: Token, scope: InjectionScope, instance: T): void {
    if (scope === "singleton") {
      this.singletons.set(token, instance);
      return;
    }

    if (scope === "request") {
      const context = this.getCurrentContextObject();
      if (!context) {
        return;
      }

      const cachedByToken = this.requestScopedInstances.get(context) ?? new Map<Token, unknown>();
      cachedByToken.set(token, instance);
      this.requestScopedInstances.set(context, cachedByToken);
    }
  }

  private cacheByScopeWithContext(
    token: Token,
    scope: InjectionScope,
    instance: unknown,
    context: object | undefined,
  ): void {
    if (scope === "singleton") {
      this.singletons.set(token, instance);
      return;
    }

    if (scope !== "request" || !context) {
      return;
    }

    const cachedByToken = this.requestScopedInstances.get(context) ?? new Map<Token, unknown>();
    cachedByToken.set(token, instance);
    this.requestScopedInstances.set(context, cachedByToken);
  }

  private getRequestScopedInstance<T>(token: Token): T | undefined {
    const context = this.getCurrentContextObject();
    if (!context) {
      return undefined;
    }

    return this.requestScopedInstances.get(context)?.get(token) as T | undefined;
  }

  private getCurrentContextObject(): object | undefined {
    const context = this.resolutionContextStack[this.resolutionContextStack.length - 1];
    if (!context || (typeof context !== "object" && typeof context !== "function")) {
      return undefined;
    }

    return context as object;
  }

  private getStaticInjectTokens(target: Constructor): Token[] {
    const staticInject = (target as unknown as { inject?: unknown }).inject;
    if (!Array.isArray(staticInject)) {
      return [];
    }

    return staticInject as Token[];
  }

  private inferDependenciesByParamName(target: Constructor): Array<Constructor | undefined> {
    const constructorParams = this.getConstructorParamNames(target);
    if (constructorParams.length === 0) {
      return [];
    }

    const providers = this.getRegisteredClassTokens();
    const providersByName = new Map<string, Constructor>();

    for (const provider of providers) {
      if (!provider.name) {
        continue;
      }

      // Ambiguous names are ignored to avoid accidental mismatches.
      if (providersByName.has(provider.name)) {
        providersByName.delete(provider.name);
        continue;
      }

      providersByName.set(provider.name, provider);
    }

    const inferredByParamName = constructorParams.map((name) =>
      providersByName.get(this.toPascalCase(name))
    );

    // Fallback for bundled/minified code where constructor params may be minified
    // (e.g. `constructor(e){this.streamService=e}`).
    const inferredByPropertyName = this.inferDependenciesFromConstructorAssignments(
      target,
      constructorParams,
      providersByName,
    );

    return constructorParams.map(
      (_, index) => inferredByParamName[index] ?? inferredByPropertyName[index],
    );
  }

  private getRegisteredClassTokens(): Constructor[] {
    const tokens = new Set<Constructor>();

    for (const token of this.singletons.keys()) {
      if (typeof token === "function") {
        tokens.add(token);
      }
    }

    for (const [token, record] of this.records.entries()) {
      if (typeof token === "function") {
        tokens.add(token);
      }
      if (record.target) {
        tokens.add(record.target);
      }
    }

    return Array.from(tokens);
  }

  private getConstructorParamNames(target: Constructor): string[] {
    const source = target.toString();
    const match = source.match(/constructor\s*\(([^)]*)\)/m);

    if (!match || !match[1].trim()) {
      return [];
    }

    return match[1]
      .split(",")
      .map((param) => param.replace(/\/\*.*?\*\//g, "").trim())
      .map((param) => param.replace(/^\.\.\./, "").trim())
      .map((param) => param.replace(/\s*=.*$/, "").trim())
      .filter((param) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(param));
  }

  private inferDependenciesFromConstructorAssignments(
    target: Constructor,
    constructorParams: string[],
    providersByName: Map<string, Constructor>,
  ): Array<Constructor | undefined> {
    const source = target.toString();
    const constructorMatch = source.match(/constructor\s*\(([^)]*)\)\s*\{([\s\S]*?)\}/m);
    if (!constructorMatch) {
      return constructorParams.map(() => undefined);
    }

    const body = constructorMatch[2] ?? "";
    const paramIndex = new Map<string, number>();
    constructorParams.forEach((param, index) => paramIndex.set(param, index));

    const inferred: Array<Constructor | undefined> = constructorParams.map(() => undefined);

    const assignmentRegex = /this\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*([A-Za-z_$][A-Za-z0-9_$]*)/g;
    let match: RegExpExecArray | null;
    while ((match = assignmentRegex.exec(body)) !== null) {
      const propertyName = match[1];
      const rhsParamName = match[2];
      const index = paramIndex.get(rhsParamName);
      if (index === undefined || inferred[index]) {
        continue;
      }

      inferred[index] = providersByName.get(this.toPascalCase(propertyName));
    }

    return inferred;
  }

  private toPascalCase(value: string): string {
    if (!value) {
      return value;
    }

    const normalized = value
      .replace(/^_+/, "")
      // Bundlers may suffix constructor params (`streamService2`, `t0`, etc.).
      .replace(/\d+$/, "");
    if (!normalized) {
      return normalized;
    }

    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }
}
