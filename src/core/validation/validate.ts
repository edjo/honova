import type { Context } from "hono";

import { ValidationException, type ValidationIssue } from "../exceptions/http-exception.js";
import {
  isStandardSchema,
  type InferOutput,
  type StandardIssue,
  type StandardSchemaV1,
} from "./standard-schema.js";

export interface ValidateSchemas {
  body?: StandardSchemaV1;
  query?: StandardSchemaV1;
  params?: StandardSchemaV1;
  headers?: StandardSchemaV1;
}

export type ValidatedInput<T extends ValidateSchemas> = {
  [K in keyof T as T[K] extends StandardSchemaV1 ? K : never]: T[K] extends StandardSchemaV1
    ? InferOutput<T[K]>
    : never;
};

const validateStore = new WeakMap<Function, ValidateSchemas>();
const INPUT_KEY = "honova:input";

function isStage3MethodArgs(args: unknown[]): boolean {
  return (
    args.length === 2 &&
    typeof args[1] === "object" &&
    args[1] !== null &&
    (args[1] as { kind?: string }).kind === "method"
  );
}

/**
 * Declares request validation for a route. A method decorator (not a
 * parameter decorator) so it works in both legacy and TC39 stage-3 modes —
 * stage-3 has no parameter decorators.
 *
 *   @Post("/links")
 *   @Validate({ body: CreateLinkSchema })
 *   create(c: AppContext) {
 *     const { body } = getInput<{ body: CreateLink }>(c);
 *   }
 */
export function Validate(schemas: ValidateSchemas): MethodDecorator {
  for (const [source, schema] of Object.entries(schemas)) {
    if (schema && !isStandardSchema(schema)) {
      throw new Error(
        `@Validate ${source} schema does not implement Standard Schema v1. ` +
          "Use zod >= 3.24, valibot, arktype, or any spec-compliant library.",
      );
    }
  }

  return ((...args: unknown[]) => {
    if (isStage3MethodArgs(args)) {
      const [value] = args as [Function];
      validateStore.set(value, schemas);
      return;
    }

    const [target, propertyKey, descriptor] = args as [
      object,
      string | symbol,
      PropertyDescriptor,
    ];
    const fn =
      (descriptor?.value as Function | undefined) ??
      ((target as Record<string | symbol, unknown>)[propertyKey] as Function | undefined);
    if (fn) {
      validateStore.set(fn, schemas);
    }

    return descriptor;
  }) as MethodDecorator;
}

export function getValidateSchemas(handler: Function | undefined): ValidateSchemas | undefined {
  return handler ? validateStore.get(handler) : undefined;
}

function toIssues(issues: ReadonlyArray<StandardIssue>): ValidationIssue[] {
  return issues.map((issue) => ({
    message: issue.message,
    path: (issue.path ?? [])
      .map((segment) =>
        typeof segment === "object" && segment !== null && "key" in segment
          ? String(segment.key)
          : String(segment),
      )
      .join("."),
  }));
}

async function parseSource(
  c: Context,
  source: keyof ValidateSchemas,
): Promise<unknown> {
  switch (source) {
    case "body": {
      const contentType = c.req.header("content-type") ?? "";
      if (contentType.includes("application/json")) {
        try {
          return await c.req.json();
        } catch {
          throw new ValidationException("body", [
            { path: "", message: "Invalid JSON body" },
          ]);
        }
      }
      if (
        contentType.includes("application/x-www-form-urlencoded") ||
        contentType.includes("multipart/form-data")
      ) {
        const form = await c.req.parseBody();
        return form;
      }
      try {
        return await c.req.json();
      } catch {
        throw new ValidationException("body", [
          { path: "", message: "Expected a JSON body" },
        ]);
      }
    }
    case "query": {
      // c.req.query() returns a null-prototype object since hono 4.12.32;
      // spread into a plain object before handing it to schema libraries.
      return { ...c.req.query() };
    }
    case "params":
      return { ...c.req.param() };
    case "headers": {
      const headers: Record<string, string> = {};
      c.req.raw.headers.forEach((value, key) => {
        headers[key] = value;
      });
      return headers;
    }
  }
}

/** Runs the route's declared schemas; throws ValidationException on failure. */
export async function runValidation(
  c: Context,
  schemas: ValidateSchemas,
): Promise<Record<string, unknown>> {
  const input: Record<string, unknown> = {};

  for (const source of ["params", "query", "headers", "body"] as const) {
    const schema = schemas[source];
    if (!schema) {
      continue;
    }

    const raw = await parseSource(c, source);
    const result = await schema["~standard"].validate(raw);

    if (result.issues) {
      throw new ValidationException(source, toIssues(result.issues));
    }

    input[source] = result.value;
  }

  c.set(INPUT_KEY as never, input as never);
  return input;
}

/**
 * Typed accessor for the validated input of the current route.
 * Shape matches the @Validate declaration: { body?, query?, params?, headers? }.
 */
export function getInput<T extends Record<string, unknown>>(c: Context): T {
  const input = c.get(INPUT_KEY as never) as T | undefined;
  if (!input) {
    throw new Error(
      "No validated input on this request. Declare schemas with @Validate({...}) on the handler.",
    );
  }

  return input;
}
