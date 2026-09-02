import type { Constructor } from "../core/types";
import type { Application } from "../core/application";
import type { ApplicationContext } from "../core/standalone";

/**
 * @Cron compiles to Cloudflare Cron Triggers, not to in-process timers —
 * Workers have no resident process. The decorated expression must match a
 * cron in wrangler's triggers.crons; "*" runs on every trigger.
 */

interface CronEntry {
  expression: string;
  handlerName: string | symbol;
}

const cronStore = new WeakMap<Function, { expression: string }>();

export function Cron(expression: string): MethodDecorator {
  return ((...args: unknown[]) => {
    if (
      args.length === 2 &&
      typeof args[1] === "object" &&
      args[1] !== null &&
      (args[1] as { kind?: string }).kind === "method"
    ) {
      const [value] = args as [Function];
      cronStore.set(value, { expression });
      return;
    }

    const [, , descriptor] = args as [object, string | symbol, PropertyDescriptor];
    const fn = descriptor?.value as Function | undefined;
    if (fn) {
      cronStore.set(fn, { expression });
    }

    return descriptor;
  }) as MethodDecorator;
}

function getCronEntries(providerClass: Constructor): CronEntry[] {
  const prototype = providerClass.prototype as Record<string | symbol, unknown> | undefined;
  if (!prototype) {
    return [];
  }

  const names = [
    ...Object.getOwnPropertyNames(prototype),
    ...Object.getOwnPropertySymbols(prototype),
  ].filter((name) => name !== "constructor");

  const entries: CronEntry[] = [];
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    const value = descriptor?.value;
    if (typeof value !== "function") {
      continue;
    }

    const metadata = cronStore.get(value);
    if (metadata) {
      entries.push({ expression: metadata.expression, handlerName: name });
    }
  }

  return entries;
}

export interface ScheduledEvent {
  cron: string;
  scheduledTime: number;
}

export interface ScheduledContext<Env extends Record<string, unknown> = Record<string, unknown>> {
  cron: string;
  scheduledTime: Date;
  env: Env;
  executionCtx: { waitUntil(promise: Promise<unknown>): void };
}

type Source = Pick<Application, "getContainer" | "getRegisteredProviders"> | ApplicationContext;

function containerOf(source: Source) {
  return "container" in source ? source.container : source.getContainer();
}

function providersOf(source: Source): Constructor[] {
  return source.getRegisteredProviders();
}

/**
 * Builds the Worker's `scheduled()` handler from every @Cron method on the
 * app's providers. Wire it up next to fetch:
 *
 *   const app = createApp(...);
 *   export default { fetch: app.fetch, scheduled: createScheduledDispatcher(app) };
 */
export function createScheduledDispatcher<Env extends Record<string, unknown>>(
  source: Source,
): (event: ScheduledEvent, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) => Promise<void> {
  return async (event, env, ctx) => {
    // Cron handlers enter outside the HTTP middleware chain; without this,
    // providers depending on CONFIG would crash in scheduled() invocations.
    const maybeApp = source as { ensureConfig?: (env: unknown) => Promise<void> };
    if (typeof maybeApp.ensureConfig === "function") {
      await maybeApp.ensureConfig(env);
    }

    const container = containerOf(source);
    const scheduledContext: ScheduledContext<Env> = {
      cron: event.cron,
      scheduledTime: new Date(event.scheduledTime),
      env,
      executionCtx: ctx,
    };

    const jobs: Array<Promise<unknown>> = [];

    for (const providerClass of providersOf(source)) {
      for (const entry of getCronEntries(providerClass)) {
        if (entry.expression !== "*" && entry.expression !== event.cron) {
          continue;
        }

        const job = (async () => {
          const provider = (await container.resolveWithContextAsync(
            providerClass,
            scheduledContext,
          )) as Record<PropertyKey, unknown>;
          const method = provider[entry.handlerName];
          if (typeof method === "function") {
            await (method as (c: ScheduledContext<Env>) => unknown).call(
              provider,
              scheduledContext,
            );
          }
        })();

        jobs.push(
          job.catch((error) => {
            console.error(
              `@Cron ${String(entry.handlerName)} on ${providerClass.name} failed:`,
              error,
            );
          }),
        );
      }
    }

    await Promise.all(jobs);
  };
}
