import type { RetryPolicy } from "./types.js";

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 5,
  maxRateLimitWaits: 10,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  jitterMs: 500,
};

/** Exponential backoff with jitter: min(max, base * 2^(n-1)) + random * jitter. */
export function backoffMs(policy: RetryPolicy, n: number, random: () => number): number {
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, n - 1));
  return exp + random() * policy.jitterMs;
}

/**
 * Parse a Retry-After header: integer seconds, or an HTTP-date. Returns seconds (never negative).
 * Falls back to 1 — the server's current floor — when the header is missing or unreadable.
 */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number {
  if (value == null) return 1;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) return Math.max(0, Math.ceil((date - now) / 1000));
  return 1;
}
