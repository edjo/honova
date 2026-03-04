import { getInjectableMetadata, getInjectionTokens } from "../metadata";
import type { Constructor, OnModuleInit } from "../types";

type Token = Constructor | string | symbol;

interface ContainerConfig {
  strict: boolean;
}

const defaultConfig: ContainerConfig = {
  strict: true,
};

export class Container {
  private static instance: Container;
  private readonly singletons = new Map<Token, unknown>();
  private readonly requestScopedInstances = new WeakMap<object, Map<Token, unknown>>();
  private readonly factories = new Map<Token, () => unknown>();
  private readonly resolving = new Set<Token>();
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
  }

  configure(config: Partial<ContainerConfig>): void {
    this.config = {
      ...this.config,
      ...config,
    };
  }

  register<T>(token: Constructor<T> | string | symbol, factory?: () => T): void {
    if (factory) {
      this.factories.set(token, factory as () => unknown);
      return;
    }

    if (typeof token === "function") {
      this.factories.set(token, () => this.createInstance(token));
    }
  }

  has(token: Token): boolean {
    return this.singletons.has(token) || this.factories.has(token);
  }

  resolve<T>(token: Constructor<T> | string | symbol): T {
    const classScope = this.getScopeForToken(token);

    if (this.singletons.has(token)) {
      return this.singletons.get(token) as T;
    }

    if (classScope === "request") {
      const cachedRequestInstance = this.getRequestScopedInstance<T>(token);
      if (cachedRequestInstance) {
        return cachedRequestInstance;
      }
    }

    if (this.resolving.has(token)) {
      throw new Error(`Circular dependency detected for token: ${String(token)}`);
    }

    const factory = this.factories.get(token);
    if (!factory) {
      throw new Error(`No provider found for token: ${String(token)}`);
    }

    this.resolving.add(token);
    try {
      const instance = factory() as T;
      this.invokeOnModuleInit(instance);
      this.cacheInstanceByScope(token, classScope, instance);
      return instance;
    } finally {
      this.resolving.delete(token);
    }
  }

  resolveWithContext<T>(token: Constructor<T> | string | symbol, context: unknown): T {
    this.resolutionContextStack.push(context);
    try {
      return this.resolve(token);
    } finally {
      this.resolutionContextStack.pop();
    }
  }

  private createInstance<T>(target: Constructor<T>): T {
    const injections = getInjectionTokens(target);
    const inferredDependencies = this.inferDependenciesByParamName(target);

    const paramCount = Math.max(
      target.length,
      injections.size > 0 ? Math.max(...injections.keys()) + 1 : 0,
      inferredDependencies.length,
    );

    const deps: unknown[] = [];
    for (let index = 0; index < paramCount; index += 1) {
      const token = injections.get(index) ?? inferredDependencies[index];

      if (!token) {
        if (this.config.strict) {
          throw new Error(
            `Cannot resolve dependency #${index} of ${target.name}. Ensure constructor param matches a registered provider name or use @Inject(token).`,
          );
        }

        deps.push(undefined);
        continue;
      }

      deps.push(this.resolve(token));
    }

    const InstantiableTarget = target as unknown as new (...args: unknown[]) => T;
    return new InstantiableTarget(...deps);
  }

  private invokeOnModuleInit(instance: unknown): void {
    if (!instance || typeof instance !== "object") {
      return;
    }

    const maybeLifecycle = instance as Partial<OnModuleInit>;
    if (typeof maybeLifecycle.onModuleInit !== "function") {
      return;
    }

    const context = this.resolutionContextStack[this.resolutionContextStack.length - 1];
    const result = maybeLifecycle.onModuleInit.call(instance, context) as unknown;
    if (
      result !== null &&
      result !== undefined &&
      typeof (result as Promise<unknown>).then === "function"
    ) {
      throw new Error(
        "onModuleInit must be synchronous in current Honova runtime.",
      );
    }
  }

  private getScopeForToken(token: Token): "singleton" | "request" | "transient" | null {
    if (typeof token !== "function") {
      return null;
    }

    const metadata = getInjectableMetadata(token);
    return metadata?.scope ?? "singleton";
  }

  private cacheInstanceByScope<T>(
    token: Token,
    scope: "singleton" | "request" | "transient" | null,
    instance: T,
  ): void {
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

  private getRequestScopedInstance<T>(token: Token): T | undefined {
    const context = this.getCurrentContextObject();
    if (!context) {
      return undefined;
    }

    const cachedByToken = this.requestScopedInstances.get(context);
    if (!cachedByToken) {
      return undefined;
    }

    return cachedByToken.get(token) as T | undefined;
  }

  private getCurrentContextObject(): object | undefined {
    const context = this.resolutionContextStack[this.resolutionContextStack.length - 1];
    if (!context || (typeof context !== "object" && typeof context !== "function")) {
      return undefined;
    }

    return context as object;
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
    // In that case, infer token by assignment target (`streamService` -> `StreamService`).
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

    for (const token of this.factories.keys()) {
      if (typeof token === "function") {
        tokens.add(token);
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
