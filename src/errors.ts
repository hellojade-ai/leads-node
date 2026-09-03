/** Base class for everything this client throws on purpose. */
export class IntakeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "IntakeError";
    if (options && "cause" in options) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/**
 * The API answered with a status this client does not treat as success.
 * `code` is the body's `error` string (e.g. "unauthorized", "invalid_json", "body_too_large").
 */
export class ApiError extends IntakeError {
  readonly status: number;
  readonly code: string | null;
  readonly requestId: string | null;
  readonly body: unknown;

  constructor(
    status: number,
    body: unknown,
    requestId: string | null,
    message?: string,
  ) {
    const code = errorCode(body);
    super(
      message ??
        `intake: HTTP ${status}${code ? ` ${code}` : ""}${requestId ? ` (request_id=${requestId})` : ""}`,
    );
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.body = body;
  }
}

/** 422. `fields` maps EVERY failing field to a reason ("required", "too_long", "out_of_range"). */
export class ValidationError extends ApiError {
  readonly fields: Record<string, string>;

  constructor(body: unknown, requestId: string | null) {
    const fields = validationFields(body);
    const names = Object.keys(fields);
    super(
      422,
      body,
      requestId,
      `intake: validation failed on ${names.length} field${names.length === 1 ? "" : "s"}: ${names
        .map((n) => `${n}=${fields[n]}`)
        .join(", ")}${requestId ? ` (request_id=${requestId})` : ""}`,
    );
    this.name = "ValidationError";
    this.fields = fields;
  }
}

/** 429, thrown only after the retry policy's rate-limit waits are exhausted. */
export class RateLimitedError extends ApiError {
  /** The last Retry-After the server sent, in seconds. */
  readonly retryAfter: number;

  constructor(body: unknown, requestId: string | null, retryAfter: number) {
    super(429, body, requestId, `intake: rate limited for too long (last Retry-After=${retryAfter}s)`);
    this.name = "RateLimitedError";
    this.retryAfter = retryAfter;
  }
}

/** A network error or timeout that persisted through every retry. `cause` is the last underlying error. */
export class TransportError extends IntakeError {
  readonly attempts: number;

  constructor(attempts: number, cause: unknown) {
    super(`intake: request failed after ${attempts} attempt${attempts === 1 ? "" : "s"}: ${describe(cause)}`, {
      cause,
    });
    this.name = "TransportError";
    this.attempts = attempts;
  }
}

function errorCode(body: unknown): string | null {
  if (body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string") {
    return (body as { error: string }).error;
  }
  return null;
}

function validationFields(body: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const fields = body && typeof body === "object" ? (body as { fields?: unknown }).fields : undefined;
  if (fields && typeof fields === "object") {
    for (const [k, v] of Object.entries(fields as Record<string, unknown>)) {
      out[k] = typeof v === "string" ? v : String(v);
    }
  }
  return out;
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}
