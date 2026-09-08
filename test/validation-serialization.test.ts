import { describe, expect, it } from "vitest";
import type { Context } from "hono";

import {
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  Validate,
  createTestingModule,
  getInput,
  type StandardSchemaV1,
} from "../src/index";

/**
 * Hand-rolled Standard Schema v1 helper — no schema library involved.
 * The framework must only rely on the `~standard` contract.
 */
type Issue = { message: string; path?: Array<PropertyKey | { key: PropertyKey }> };
type Result<Output> = { value: Output } | { issues: Issue[] };

function makeSchema<Output>(
  validate: (value: unknown) => Result<Output> | Promise<Result<Output>>,
): StandardSchemaV1<unknown, Output> {
  return {
    "~standard": {
      version: 1,
      vendor: "test",
      validate,
    },
  };
}

/** Body schema that TRANSFORMS: `age` comes in as a string, goes out a number. */
const createItemSchema = makeSchema<{ name: string; age: number }>((value) => {
  if (typeof value !== "object" || value === null) {
    return { issues: [{ message: "Expected an object" }] };
  }

  const record = value as Record<string, unknown>;
  const issues: Issue[] = [];

  if (typeof record.name !== "string" || record.name.length === 0) {
    issues.push({ message: "name is required", path: ["name"] });
  }

  const age = typeof record.age === "string" ? Number(record.age) : Number.NaN;
  if (Number.isNaN(age)) {
    issues.push({ message: "age must be a numeric string", path: ["age"] });
  }

  if (issues.length > 0) {
    return { issues };
  }

  return { value: { name: record.name as string, age } };
});

/** Query schema, also transforming: limit string -> number. */
const listQuerySchema = makeSchema<{ limit: number }>((value) => {
  const limit = (value as Record<string, unknown>).limit;
  const parsed = typeof limit === "string" ? Number(limit) : Number.NaN;
  if (Number.isNaN(parsed)) {
    return { issues: [{ message: "limit must be a number", path: ["limit"] }] };
  }

  return { value: { limit: parsed } };
});

/** Params schema for the :id route segment, transforming id string -> number. */
const itemParamsSchema = makeSchema<{ id: number }>((value) => {
  const id = (value as Record<string, unknown>).id;
  const parsed = typeof id === "string" ? Number(id) : Number.NaN;
  if (Number.isNaN(parsed)) {
    return { issues: [{ message: "id must be numeric", path: ["id"] }] };
  }

  return { value: { id: parsed } };
});

/** Headers schema; uses the `{ key }` path-segment form from the spec. */
const secureHeadersSchema = makeSchema<{ apiKey: string }>((value) => {
  const apiKey = (value as Record<string, unknown>)["x-api-key"];
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    return {
      issues: [{ message: "x-api-key header is required", path: [{ key: "x-api-key" }] }],
    };
  }

  return { value: { apiKey } };
});

/** Async schema: validate() returns a Promise. */
const asyncBodySchema = makeSchema<{ token: string }>(async (value) => {
  await Promise.resolve();
  const token = (value as Record<string, unknown> | null)?.token;
  if (typeof token !== "string") {
    return { issues: [{ message: "token is required", path: ["token"] }] };
  }

  return { value: { token: token.toUpperCase() } };
});

@Controller("/api")
class ValidationController {
  @Post("/items")
  @Validate({ body: createItemSchema })
  createItem(c: Context) {
    const { body } = getInput<{ body: { name: string; age: number } }>(c);
    return { received: body, ageType: typeof body.age };
  }

  @Get("/items")
  @Validate({ query: listQuerySchema })
  listItems(c: Context) {
    const { query } = getInput<{ query: { limit: number } }>(c);
    return { limit: query.limit, limitType: typeof query.limit };
  }

  @Get("/items/:id")
  @Validate({ params: itemParamsSchema })
  getItem(c: Context) {
    const { params } = getInput<{ params: { id: number } }>(c);
    return { id: params.id, idType: typeof params.id };
  }

  @Get("/secure")
  @Validate({ headers: secureHeadersSchema })
  secure(c: Context) {
    const { headers } = getInput<{ headers: { apiKey: string } }>(c);
    return { apiKey: headers.apiKey };
  }

  @Post("/async")
  @Validate({ body: asyncBodySchema })
  asyncValidated(c: Context) {
    const { body } = getInput<{ body: { token: string } }>(c);
    return { token: body.token };
  }

  @Get("/no-validate")
  noValidate(c: Context) {
    try {
      getInput(c);
      return { threw: false as const };
    } catch (error) {
      return {
        threw: true as const,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

@Controller("/ser")
class SerializationController {
  @Get("/object")
  object() {
    return { hello: "world", nested: { n: 1 } };
  }

  @Get("/text")
  text() {
    return "plain text";
  }

  @Get("/null")
  returnsNull() {
    return null;
  }

  @Get("/undefined")
  returnsUndefined() {
    return undefined;
  }

  @Get("/own-response")
  ownResponse() {
    return new Response("i am raw", { status: 418, headers: { "x-own": "yes" } });
  }

  @Post("/created")
  @HttpCode(201)
  @Header("x-custom", "1")
  created() {
    return { created: true };
  }

  @Get("/own-response-decorated")
  @HttpCode(201)
  @Header("x-custom", "1")
  ownResponseDecorated() {
    return new Response("untouched", { status: 202, headers: { "x-own": "yes" } });
  }
}

const testApp = createTestingModule(
  { controllers: [ValidationController, SerializationController] },
  { observability: { enableAccessLogs: false } },
).compile();

describe("@Validate with Standard Schema", () => {
  it("stores the schema OUTPUT (transformed string->number), readable via getInput", async () => {
    const res = await testApp.request("/api/items", {
      method: "POST",
      json: { name: "widget", age: "42" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      received: { name: "widget", age: 42 },
      ageType: "number",
    });
  });

  it("returns 400 validation_failed with source and per-issue path/message for an invalid body", async () => {
    const res = await testApp.request("/api/items", {
      method: "POST",
      json: { name: "", age: "not-a-number" },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: {
        code: string;
        message: string;
        details: { source: string; issues: Array<{ path: string; message: string }> };
      };
    };
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.message).toBe("Validation failed for body");
    expect(body.error.details.source).toBe("body");
    expect(body.error.details.issues).toEqual([
      { path: "name", message: "name is required" },
      { path: "age", message: "age must be a numeric string" },
    ]);
  });

  it("returns 400 validation_failed 'Invalid JSON body' for malformed JSON", async () => {
    const res = await testApp.request("/api/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ this is not json",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details: { source: string; issues: Array<{ path: string; message: string }> } };
    };
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.details.source).toBe("body");
    expect(body.error.details.issues).toEqual([{ path: "", message: "Invalid JSON body" }]);
  });

  it("validates query strings and stores the transformed output", async () => {
    const res = await testApp.request("/api/items?limit=10");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ limit: 10, limitType: "number" });
  });

  it("reports source 'query' on query failure", async () => {
    const res = await testApp.request("/api/items?limit=abc");

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details: { source: string; issues: Array<{ path: string; message: string }> } };
    };
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.details.source).toBe("query");
    expect(body.error.details.issues).toEqual([
      { path: "limit", message: "limit must be a number" },
    ]);
  });

  it("validates route :id params and stores the transformed output", async () => {
    const res = await testApp.request("/api/items/123");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 123, idType: "number" });
  });

  it("reports source 'params' on params failure", async () => {
    const res = await testApp.request("/api/items/abc");

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details: { source: string; issues: Array<{ path: string; message: string }> } };
    };
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.details.source).toBe("params");
    expect(body.error.details.issues).toEqual([{ path: "id", message: "id must be numeric" }]);
  });

  it("validates headers", async () => {
    const res = await testApp.request("/api/secure", {
      headers: { "x-api-key": "secret-key" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ apiKey: "secret-key" });
  });

  it("reports source 'headers' on header failure and flattens { key } path segments", async () => {
    const res = await testApp.request("/api/secure");

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details: { source: string; issues: Array<{ path: string; message: string }> } };
    };
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.details.source).toBe("headers");
    expect(body.error.details.issues).toEqual([
      { path: "x-api-key", message: "x-api-key header is required" },
    ]);
  });

  it("supports async validate() returning a Promise (success)", async () => {
    const res = await testApp.request("/api/async", {
      method: "POST",
      json: { token: "abc" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: "ABC" });
  });

  it("supports async validate() returning a Promise (failure)", async () => {
    const res = await testApp.request("/api/async", {
      method: "POST",
      json: { nope: true },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details: { source: string; issues: Array<{ path: string; message: string }> } };
    };
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.details.issues).toEqual([{ path: "token", message: "token is required" }]);
  });

  it("getInput throws a clear error on a route without @Validate", async () => {
    const res = await testApp.request("/api/no-validate");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { threw: boolean; message?: string };
    expect(body.threw).toBe(true);
    expect(body.message).toContain("No validated input");
    expect(body.message).toContain("@Validate");
  });
});

describe("response serialization", () => {
  it("serializes a plain object as JSON 200", async () => {
    const res = await testApp.request("/ser/object");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ hello: "world", nested: { n: 1 } });
  });

  it("serializes a string as text/plain 200", async () => {
    const res = await testApp.request("/ser/text");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe("plain text");
  });

  it("serializes null as 204 with an empty body", async () => {
    const res = await testApp.request("/ser/null");

    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("serializes undefined as 204 with an empty body", async () => {
    const res = await testApp.request("/ser/undefined");

    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("passes a handler-returned Response through untouched", async () => {
    const res = await testApp.request("/ser/own-response");

    expect(res.status).toBe(418);
    expect(res.headers.get("x-own")).toBe("yes");
    expect(await res.text()).toBe("i am raw");
  });

  it("applies @HttpCode(201) and @Header to serialized objects", async () => {
    const res = await testApp.request("/ser/created", { method: "POST" });

    expect(res.status).toBe(201);
    expect(res.headers.get("x-custom")).toBe("1");
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ created: true });
  });

  it("does NOT apply @HttpCode/@Header when the handler returns its own Response", async () => {
    const res = await testApp.request("/ser/own-response-decorated");

    expect(res.status).toBe(202);
    expect(res.headers.get("x-custom")).toBeNull();
    expect(res.headers.get("x-own")).toBe("yes");
    expect(await res.text()).toBe("untouched");
  });
});
