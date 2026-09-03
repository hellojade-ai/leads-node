import { randomUUID } from "node:crypto";
import { ApiError, RateLimitedError, TransportError, ValidationError } from "./errors.js";
import { backoffMs, DEFAULT_RETRY, firstHeader, parseRetryAfter } from "./retry.js";
import type {
  Accepted,
  FetchLike,
  Health,
  IntakeClientOptions,
  KeyCheck,
  Lead,
  RetryPolicy,
  SubmitOptions,
  Vocabulary,
} from "./types.js";

export const VERSION = "0.1.1";
export const DEFAULT_BASE_URL = "https://intake.hellojade.ai";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

interface Attempt {
  status: number;
  headers: Headers;
  body: unknown;
  text: string;
}

interface RequestSpec {
  method: "GET" | "POST";
  path: string;
  body?: string;
  headers?: Record<string, string>;
  /** Retry transport errors and 5xx per the policy. */
  retry: boolean;
  /** Treat 429 as retryable (wait Retry-After). */
  retryRateLimit: boolean;
  signal?: AbortSignal | undefined;
}

/**
 * Client for the hellojade Partner Intake API.
 *
 * Every rule from the integration brief is built in: the retry policy retries only on
 * transport errors, 5xx, and 429 (honoring Retry-After without consuming an attempt);
 * every other 4xx throws immediately; `Idempotency-Key` is required on every submit;
 * `source` is refused client-side because your API key IS the source.
 */
export class IntakeClient {
  readonly baseUrl: string;
  readonly retry: RetryPolicy;
  readonly timeoutMs: number;
  readonly userAgent: string;
  readonly idempotencyNamespace: string | undefined;

  private readonly apiKey: string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(options: IntakeClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.apiKey = options.apiKey;
    this.retry = { ...DEFAULT_RETRY, ...(options.retry ?? {}) };
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.userAgent =
      options.userAgent ?? `@hellojade/intake/${VERSION} node/${process.versions.node}`;
    this.idempotencyNamespace = options.idempotencyNamespace;
    const f = options.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (typeof f !== "function") {
      throw new TypeError(
        "intake: no fetch available — pass { fetch } or run on Node 18+ (global fetch)",
      );
    }
    this.fetchImpl = f;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = options.random ?? Math.random;
  }

  /**
   * Prove the key works WITHOUT creating a lead. Sends `{}` with the key; the API
   * authenticates before it validates, so 422 means "key valid, nothing stored" and
   * 401 means the key is wrong. Neither throws — read `valid`.
   */
  async checkKey(options: { requestId?: string; signal?: AbortSignal } = {}): Promise<KeyCheck> {
    const requestId = options.requestId ?? randomUUID();
    const res = await this.request({
      method: "POST",
      path: "/v1/intake",
      body: "{}",
      headers: { ...this.authHeaders(), "X-Request-Id": requestId },
      retry: true,
      retryRateLimit: true,
      signal: options.signal,
    });
    const rid = firstHeader(res.headers, "x-request-id") ?? bodyRequestId(res.body);
    if (res.status === 422) {
      const fields = (res.body as { fields?: Record<string, string> } | null)?.fields ?? {};
      return { valid: true, status: 422, requestId: rid, required: Object.keys(fields).sort() };
    }
    if (res.status === 401) {
      return { valid: false, status: 401, requestId: rid, required: [] };
    }
    throw new ApiError(res.status, res.body, rid);
  }

  /**
   * Submit one lead. Resolves on 202 (accepted) and on 200 (duplicate of an
   * Idempotency-Key already accepted — same `event_id` as the first time; that is a success).
   *
   * Throws ValidationError (422, with every failing field), ApiError (400/401/413/other 4xx),
   * RateLimitedError (429 beyond the policy's waits), TransportError (network/timeout beyond
   * the policy's attempts), or TypeError for a client-side contract violation.
   */
  async submitLead(lead: Lead, options: SubmitOptions): Promise<Accepted> {
    if (!options || typeof options.idempotencyKey !== "string" || options.idempotencyKey.length === 0) {
      throw new TypeError(
        "intake: submitLead requires { idempotencyKey } — your own stable id for this lead (rule 2)",
      );
    }
    if (!lead || typeof lead !== "object" || Array.isArray(lead)) {
      throw new TypeError("intake: lead must be a plain object");
    }
    if ("source" in lead) {
      throw new TypeError(
        "intake: do not send `source` — your API key's registered label is the source (rule 6). Ask hellojade for a second key if you need a second source.",
      );
    }
    if ("extra" in lead && (lead.extra === null || typeof lead.extra !== "object" || Array.isArray(lead.extra))) {
      throw new TypeError(
        "intake: `extra` is a reserved key; send additional fields at the top level and the API collects them for you",
      );
    }
    if (!this.apiKey) {
      throw new TypeError("intake: apiKey is required to submit a lead");
    }
    const requestId = options.requestId ?? randomUUID();
    const key = this.idempotencyNamespace
      ? `${this.idempotencyNamespace}:${options.idempotencyKey}`
      : options.idempotencyKey;
    const res = await this.request({
      method: "POST",
      path: "/v1/intake",
      body: JSON.stringify(lead),
      headers: { ...this.authHeaders(), "Idempotency-Key": key, "X-Request-Id": requestId },
      retry: true,
      retryRateLimit: true,
      signal: options.signal,
    });
    const rid = firstHeader(res.headers, "x-request-id") ?? bodyRequestId(res.body);
    if (res.status === 202 || res.status === 200) {
      const b = (res.body ?? {}) as Partial<Accepted>;
      return {
        event_id: String(b.event_id ?? ""),
        status: b.status === "duplicate" ? "duplicate" : "accepted",
        received_at: String(b.received_at ?? ""),
        flags: Array.isArray(b.flags) ? b.flags : [],
        ...(typeof b.source === "string" ? { source: b.source } : {}),
        requestId: rid,
      };
    }
    throw this.errorFor(res, rid);
  }

  /** The live project_area vocabulary and the closed project_service enum. Unauthenticated. */
  async vocabulary(options: { signal?: AbortSignal } = {}): Promise<Vocabulary> {
    const res = await this.request({
      method: "GET",
      path: "/v1/vocabulary",
      retry: true,
      retryRateLimit: true,
      signal: options.signal,
    });
    if (res.status === 200 && res.body && typeof res.body === "object") {
      const b = res.body as Partial<Vocabulary>;
      return {
        project_area: Array.isArray(b.project_area) ? b.project_area : [],
        project_service: Array.isArray(b.project_service) ? b.project_service : [],
        required: Array.isArray(b.required) ? b.required : [],
      };
    }
    throw this.errorFor(res, firstHeader(res.headers, "x-request-id"));
  }

  /** Liveness. Returns the body on both 200 and 503 (`ok` says which); never retries. */
  async health(options: { signal?: AbortSignal } = {}): Promise<Health> {
    const res = await this.request({
      method: "GET",
      path: "/healthz",
      retry: false,
      retryRateLimit: false,
      signal: options.signal,
    });
    if ((res.status === 200 || res.status === 503) && res.body && typeof res.body === "object") {
      const b = res.body as Partial<Health>;
      return {
        ok: Boolean(b.ok),
        store_writable: Boolean(b.store_writable),
        pending: Number(b.pending ?? 0),
        dead: Number(b.dead ?? 0),
        oldest_pending_age_s: b.oldest_pending_age_s == null ? null : Number(b.oldest_pending_age_s),
      };
    }
    throw this.errorFor(res, firstHeader(res.headers, "x-request-id"));
  }

  // ---------------------------------------------------------------------------

  private authHeaders(): Record<string, string> {
    return this.apiKey ? { "X-API-Key": this.apiKey } : {};
  }

  private errorFor(res: Attempt, requestId: string | null): ApiError {
    if (res.status === 422) return new ValidationError(res.body, requestId);
    return new ApiError(res.status, res.body, requestId);
  }

  /**
   * One logical request with the retry policy applied:
   *  - transport error / timeout / 5xx: retry with backoff, up to maxAttempts
   *  - 429: wait max(Retry-After, backoff(waits)), does NOT consume an attempt
   *  - anything else: return to the caller (who decides success vs. ApiError)
   */
  private async request(spec: RequestSpec): Promise<Attempt> {
    const policy = this.retry;
    const maxAttempts = spec.retry ? Math.max(1, policy.maxAttempts) : 1;
    let rateLimitWaits = 0;
    let attempt = 0;
    let lastCause: unknown;

    for (;;) {
      attempt += 1;
      throwIfAborted(spec.signal);
      let res: Attempt;
      try {
        res = await this.once(spec);
      } catch (err) {
        if (spec.signal?.aborted) throw err;
        lastCause = err;
        if (!spec.retry || attempt >= maxAttempts) throw new TransportError(attempt, err);
        await this.sleep(backoffMs(policy, attempt, this.random));
        continue;
      }

      if (res.status === 429 && spec.retryRateLimit) {
        const retryAfter = parseRetryAfter(firstHeader(res.headers, "retry-after"));
        rateLimitWaits += 1;
        if (rateLimitWaits > policy.maxRateLimitWaits) {
          throw new RateLimitedError(res.body, firstHeader(res.headers, "x-request-id"), retryAfter);
        }
        await this.sleep(Math.max(retryAfter * 1000, backoffMs(policy, rateLimitWaits, this.random)));
        attempt -= 1; // a rate-limit wait is not a delivery attempt
        continue;
      }

      if (res.status >= 500 && spec.retry) {
        lastCause = new ApiError(res.status, res.body, firstHeader(res.headers, "x-request-id"));
        if (attempt >= maxAttempts) throw lastCause;
        await this.sleep(backoffMs(policy, attempt, this.random));
        continue;
      }

      return res;
    }
  }

  private async once(spec: RequestSpec): Promise<Attempt> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`intake: timeout after ${this.timeoutMs}ms`)), this.timeoutMs);
    const onOuterAbort = () => controller.abort(spec.signal?.reason);
    if (spec.signal) {
      if (spec.signal.aborted) onOuterAbort();
      else spec.signal.addEventListener("abort", onOuterAbort, { once: true });
    }
    try {
      const headers: Record<string, string> = {
        Accept: "application/json",
        "User-Agent": this.userAgent,
        ...(spec.headers ?? {}),
      };
      if (spec.body !== undefined) headers["Content-Type"] = "application/json";
      const init: RequestInit = { method: spec.method, headers, signal: controller.signal };
      if (spec.body !== undefined) init.body = spec.body;
      const response = await this.fetchImpl(this.baseUrl + spec.path, init);
      const text = await response.text();
      let body: unknown = null;
      if (text.length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
      }
      return { status: response.status, headers: response.headers, body, text };
    } finally {
      clearTimeout(timer);
      spec.signal?.removeEventListener("abort", onOuterAbort);
    }
  }
}

function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError(`intake: baseUrl is not a valid URL: ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))) {
    throw new TypeError(
      `intake: baseUrl must be https (nothing listens on port 80 and there is no redirect); got ${url.protocol}//${url.host}`,
    );
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

function bodyRequestId(body: unknown): string | null {
  if (body && typeof body === "object" && typeof (body as { request_id?: unknown }).request_id === "string") {
    return (body as { request_id: string }).request_id;
  }
  return null;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("intake: aborted");
  }
}
