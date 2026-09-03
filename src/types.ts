/**
 * Types for the hellojade Partner Intake API.
 * Contract: https://intake.hellojade.ai/api/openapi.json
 */

/** The closed `project_service` enum. Unrecognized values are stored and flagged, not rejected. */
export type ProjectService = "replacement" | "repair" | "remodel" | "maintain";

/**
 * One lead. `first_name`, `last_name` and `phone` are required; everything else is optional.
 * Unmodeled top-level fields are PRESERVED by the API under `extra` (you get an
 * `extra_fields_preserved` flag back), so the index signature is deliberate.
 *
 * Do NOT include `source` — the API key you were issued is the source (rule 6).
 * `submitLead` throws if you do.
 */
export interface Lead {
  first_name: string;
  last_name: string;
  phone: string;
  email?: string;
  street_address?: string;
  city?: string;
  state?: string;
  zip?: string;
  /** ISO-3166 alpha-2. Defaults to "US" server-side when omitted. */
  country?: string;
  /** Controlled vocabulary — fetch it with `vocabulary()`, do not hard-code it. */
  project_area?: string;
  project_service?: ProjectService | (string & {});
  project_material?: string;
  /** Free text, up to 4000 characters. Line breaks are preserved here and only here. */
  project_details?: string;
  /** Your id for the lead. Recorded, never trusted as unique — dedupe uses Idempotency-Key. */
  external_id?: string;
  /** US dollars, 0.01–999.99 inclusive. Omit it entirely if there is no charge; never send 0. */
  cost?: number;
  [extra: string]: unknown;
}

/** Non-fatal observations returned on a successful submit. Their presence never changes the status. */
export type LeadFlag =
  | "phone_unnormalized"
  | "project_area_unknown"
  | "project_service_unknown"
  | "email_shape_suspect"
  | "extra_fields_preserved"
  | "country_unrecognized";

/** The body of a 202 (accepted) or 200 (duplicate) response. */
export interface Accepted {
  /** Opaque, sortable, unguessable. Store it against your lead; quote it to support. */
  event_id: string;
  /** "accepted" on a 202, "duplicate" on a 200. Both are success. */
  status: "accepted" | "duplicate";
  /** RFC 3339 timestamp. */
  received_at: string;
  /** Always an array, never null. */
  flags: Array<LeadFlag | (string & {})>;
  /** Your API key's registered label. Not something you send. */
  source?: string;
  /** The X-Request-Id the server echoed (yours if you set one). */
  requestId: string | null;
}

export interface VocabularyTerm {
  area: string;
  /** "proposed" terms are accepted exactly as "confirmed" ones are. */
  status: "confirmed" | "proposed" | (string & {});
}

/** GET /v1/vocabulary. Served from the database, cacheable for five minutes. */
export interface Vocabulary {
  project_area: VocabularyTerm[];
  project_service: string[];
  required: string[];
}

/** GET /healthz. Returned on both 200 and 503. */
export interface Health {
  ok: boolean;
  store_writable: boolean;
  pending: number;
  dead: number;
  oldest_pending_age_s: number | null;
}

/** The result of `checkKey()`. Never throws on 401 or 422 — the boolean is the answer. */
export interface KeyCheck {
  /** true when the API answered 422 (authenticated, then correctly rejected an empty body). */
  valid: boolean;
  /** 422 when valid, 401 when not. */
  status: number;
  requestId: string | null;
  /** The fields the validator currently requires (from the 422 body). Empty when invalid. */
  required: string[];
}

export interface RetryPolicy {
  /** Delivery attempts for transport errors and 5xx. Default 5. */
  maxAttempts: number;
  /** How many 429 waits to tolerate before giving up. 429s do not consume an attempt. Default 10. */
  maxRateLimitWaits: number;
  /** First backoff delay. Default 1000. */
  baseDelayMs: number;
  /** Backoff ceiling. Default 30000. */
  maxDelayMs: number;
  /** Random jitter added to every wait so a fleet of workers does not retry in lockstep. Default 500. */
  jitterMs: number;
}

/** A fetch-compatible function. Node 18+ has one globally. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface IntakeClientOptions {
  /** Defaults to https://intake.hellojade.ai. Must be https unless the host is 127.0.0.1 or localhost. */
  baseUrl?: string;
  /** Your partner key. Read it from your environment or secret store — never from source. */
  apiKey?: string;
  /** Override fetch (tests, proxies). Defaults to globalThis.fetch. */
  fetch?: FetchLike;
  /** Per-attempt timeout via AbortController. Default 20000 — the server bounds its own handler at 20 s. */
  timeoutMs?: number;
  /** Sent as User-Agent. Defaults to "@hellojade/intake/<version> node/<version>". */
  userAgent?: string;
  /** Partial overrides of the retry policy. */
  retry?: Partial<RetryPolicy>;
  /**
   * When set, every Idempotency-Key is sent as `${namespace}:${key}`.
   * Dedupe is scoped to the TENANT, not to your key — a bare id collides silently
   * with other lead sources (rule 3). Set this to something only you use.
   */
  idempotencyNamespace?: string;
  /** Injectable for tests. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests. Defaults to Math.random. */
  random?: () => number;
}

export interface SubmitOptions {
  /**
   * REQUIRED. Your own stable id for this lead — the id your system already uses, so a retry
   * of the same lead carries the same key. Not a timestamp, not a UUID minted at send time.
   */
  idempotencyKey: string;
  /** Correlation id echoed in the X-Request-Id header and in every error body. Generated if omitted. */
  requestId?: string;
  /** Abort the whole call (all attempts). */
  signal?: AbortSignal;
}
