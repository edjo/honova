/**
 * Response-shaping decorators for handlers that return plain values.
 * They only affect framework serialization; handlers returning a Response
 * keep full control.
 */

export interface ResponseExtras {
  httpCode?: number;
  headers?: Record<string, string>;
}

const responseExtras = new WeakMap<Function, ResponseExtras>();

function upsert(fn: Function, patch: Partial<ResponseExtras>): void {
  const existing = responseExtras.get(fn) ?? {};
  responseExtras.set(fn, {
    ...existing,
    ...patch,
    headers: { ...(existing.headers ?? {}), ...(patch.headers ?? {}) },
  });
}

function decorate(patch: Partial<ResponseExtras>): MethodDecorator {
  return ((...args: unknown[]) => {
    if (
      args.length === 2 &&
      typeof args[1] === "object" &&
      args[1] !== null &&
      (args[1] as { kind?: string }).kind === "method"
    ) {
      const [value] = args as [Function];
      upsert(value, patch);
      return;
    }

    const [, , descriptor] = args as [object, string | symbol, PropertyDescriptor];
    const fn = descriptor?.value as Function | undefined;
    if (fn) {
      upsert(fn, patch);
    }

    return descriptor;
  }) as MethodDecorator;
}

/** Status for serialized (non-Response) handler results. */
export function HttpCode(status: number): MethodDecorator {
  return decorate({ httpCode: status });
}

/** Adds a static header to serialized (non-Response) handler results. */
export function Header(name: string, value: string): MethodDecorator {
  return decorate({ headers: { [name]: value } });
}

export function getResponseExtras(handler: Function | undefined): ResponseExtras | undefined {
  return handler ? responseExtras.get(handler) : undefined;
}
