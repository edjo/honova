/**
 * Typed HTTP exceptions.
 *
 * Anything in the request pipeline (guards, validation, interceptors,
 * handlers, providers) may throw these; the exception layer maps them to the
 * framework's JSON error envelope. Unknown errors stay 500 internal_error.
 */

export interface HttpExceptionBody {
  code: string;
  message: string;
  details?: unknown;
}

export class HttpException extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.details = details;
  }

  toBody(): { error: HttpExceptionBody } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }

  toResponse(): Response {
    return Response.json(this.toBody(), { status: this.status });
  }
}

/**
 * The shape every typed subclass below exposes.
 *
 * Declared explicitly because an inferred anonymous class expression emits a
 * structural type in the .d.ts: the subclasses keep `message`/`stack` but lose
 * their declared relationship to `Error` and to `HttpException`, so consumers
 * cannot assign a caught exception to `Error` and lint rules like
 * `only-throw-error` reject throwing one.
 */
export type HttpExceptionConstructor = new (
  message?: string,
  details?: unknown,
  code?: string,
) => HttpException;

const make = (
  status: number,
  defaultCode: string,
  defaultMessage: string,
): HttpExceptionConstructor =>
  class extends HttpException {
    constructor(message = defaultMessage, details?: unknown, code = defaultCode) {
      super(status, code, message, details);
    }
  };

export class BadRequestException extends make(400, "bad_request", "Bad request") {}
export class UnauthorizedException extends make(401, "unauthorized", "Unauthorized") {}
export class PaymentRequiredException extends make(402, "payment_required", "Payment required") {}
export class ForbiddenException extends make(403, "forbidden", "Forbidden") {}
export class NotFoundException extends make(404, "not_found", "Not found") {}
export class MethodNotAllowedException extends make(405, "method_not_allowed", "Method not allowed") {}
export class ConflictException extends make(409, "conflict", "Conflict") {}
export class GoneException extends make(410, "gone", "Gone") {}
export class PayloadTooLargeException extends make(413, "payload_too_large", "Payload too large") {}
export class UnprocessableEntityException extends make(422, "unprocessable_entity", "Unprocessable entity") {}
export class TooManyRequestsException extends make(429, "too_many_requests", "Too many requests") {}
export class InternalServerErrorException extends make(500, "internal_error", "Internal server error") {}
export class NotImplementedException extends make(501, "not_implemented", "Not implemented") {}
export class BadGatewayException extends make(502, "bad_gateway", "Bad gateway") {}
export class ServiceUnavailableException extends make(503, "service_unavailable", "Service unavailable") {}
export class GatewayTimeoutException extends make(504, "gateway_timeout", "Gateway timeout") {}

/** One flattened validation problem, independent of the schema library. */
export interface ValidationIssue {
  path: string;
  message: string;
}

export class ValidationException extends HttpException {
  readonly issues: ValidationIssue[];

  constructor(source: "body" | "query" | "params" | "headers", issues: ValidationIssue[]) {
    super(400, "validation_failed", `Validation failed for ${source}`, { source, issues });
    this.issues = issues;
  }
}
