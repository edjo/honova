import { Container } from "./container/container.js";
import { getInjectableMetadata, getModuleMetadata } from "./metadata.js";
import type { Constructor, ProviderDefinition } from "./types.js";

export interface ApplicationContext {
  container: Container;
  resolve<T>(token: Constructor<T> | string | symbol): T;
  resolveAsync<T>(token: Constructor<T> | string | symbol): Promise<T>;
  getRegisteredProviders(): Constructor[];
}

/**
 * The DI container without HTTP — Nest's standalone application context,
 * re-targeted at Workers' non-fetch handlers: scheduled() (Cron Triggers) and
 * queue() consumers resolve providers from here. Controllers in the modules
 * are ignored.
 */
export function createApplicationContext(
  moduleClasses: Constructor[],
  options: { strict?: boolean } = {},
): ApplicationContext {
  const container = new Container();
  container.configure({ strict: options.strict ?? true });
  Container.setActive(container);

  const registeredModules = new Set<Constructor>();
  const registeredProviders = new Set<Constructor>();

  const registerProvider = (provider: ProviderDefinition, moduleClass: Constructor): void => {
    if (typeof provider === "function") {
      if (!getInjectableMetadata(provider)) {
        throw new Error(
          `Provider ${provider.name} in ${moduleClass.name} must be decorated with @Injectable().`,
        );
      }

      if (!registeredProviders.has(provider)) {
        container.register(provider);
        registeredProviders.add(provider);
      }

      return;
    }

    container.registerProvider(provider);
    if ("useClass" in provider) {
      registeredProviders.add(provider.useClass);
    }
  };

  const registerModule = (moduleClass: Constructor, stack: Constructor[]): void => {
    if (registeredModules.has(moduleClass)) {
      return;
    }

    if (stack.includes(moduleClass)) {
      const cycle = [...stack, moduleClass].map((m) => m.name).join(" -> ");
      throw new Error(`Circular module import detected: ${cycle}`);
    }

    const metadata = getModuleMetadata(moduleClass);
    if (!metadata) {
      throw new Error(`Class ${moduleClass.name} is not decorated with @Module()`);
    }

    for (const imported of metadata.imports ?? []) {
      registerModule(imported, [...stack, moduleClass]);
    }

    for (const provider of metadata.providers ?? []) {
      registerProvider(provider, moduleClass);
    }

    registeredModules.add(moduleClass);
  };

  for (const moduleClass of moduleClasses) {
    registerModule(moduleClass, []);
  }

  return {
    container,
    resolve: (token) => container.resolve(token),
    resolveAsync: (token) => container.resolveAsync(token),
    getRegisteredProviders: () => [...registeredProviders],
  };
}
