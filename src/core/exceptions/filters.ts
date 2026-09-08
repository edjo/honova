import type { Context } from "hono";

import type { Constructor } from "../types.js";
import type { ExecutionContext } from "../execution-context.js";
import { HttpException } from "./http-exception.js";

/**
 * Nest-style exception filter, HTTP-only.
 *
 * Returning a Response ends the request with it. Returning undefined passes
 * the exception to the next filter (route -> controller -> global -> default).
 */
export interface ExceptionFilter<T = unknown> {
  catch(exception: T, ctx: ExecutionContext): Response | Promise<Response | undefined> | undefined;
}

const catchTypesStore = new WeakMap<Function, Constructor[]>();

/**
 * Restricts a filter class to the given exception types. With no arguments the
 * filter catches everything.
 */
export function Catch(...exceptionTypes: Constructor[]): ClassDecorator {
  return ((...args: unknown[]) => {
    const target = args[0] as Function;
    catchTypesStore.set(target, exceptionTypes);
  }) as ClassDecorator;
}

export function getCatchTypes(filterClass: Function): Constructor[] {
  return catchTypesStore.get(filterClass) ?? [];
}

export function filterMatches(filterClass: Function | undefined, exception: unknown): boolean {
  if (!filterClass) {
    return true;
  }

  const types = getCatchTypes(filterClass);
  if (types.length === 0) {
    return true;
  }

  return types.some((type) => exception instanceof type);
}

/** Terminal mapping used when no filter produced a Response. */
export function defaultExceptionResponse(exception: unknown, c: Context): Response {
  if (exception instanceof HttpException) {
    // 4xx carry their message to the caller; 5xx messages/details describe
    // internal state, so they are logged and replaced with an opaque body.
    if (exception.status >= 500) {
      console.error(exception);
      return c.json(
        { error: { code: exception.code, message: "Internal server error" } },
        exception.status as never,
      );
    }

    return exception.toResponse();
  }

  console.error(exception);
  return c.json(
    { error: { code: "internal_error", message: "Internal server error" } },
    500,
  );
}
