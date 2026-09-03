import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  IntakeClient,
  ApiError,
  ValidationError,
  RateLimitedError,
  TransportError,
  parseRetryAfter,
  backoffMs,
  DEFAULT_RETRY,
} from "../dist/esm/index.js";
import { startStub } from "./stub.mjs";

let stub;
const sleeps = [];
const noSleep = async (ms) => {
  sleeps.push(ms);
};
const zero = () => 0;
const LEAD = { first_name: "Dana", last_name: "Whitfield", phone: "6305550142" };

function client(extra = {}) {
  return new IntakeClient({
    baseUrl: stub.url,
    apiKey: "test-key-valid",
    sleep: noSleep,
    random: zero,
    ...extra,
  });
}

before(async () => {
  stub = await startStub();
});
after(async () => {
  await stub.close();
});
beforeEach(() => {
  stub.reset();
  sleeps.length = 0;
});

// ---------------------------------------------------------------- construction

test("baseUrl must be https unless loopback", () => {
  assert.throws(() => new IntakeClient({ baseUrl: "http://intake.hellojade.ai" }), /must be https/);
  assert.doesNotThrow(() => new IntakeClient({ baseUrl: "http://127.0.0.1:9095" }));
  assert.doesNotThrow(() => new IntakeClient({ baseUrl: "http://localhost:9095" }));
  assert.equal(new IntakeClient().baseUrl, "https://intake.hellojade.ai");
  assert.equal(new IntakeClient({ baseUrl: "https://intake.hellojade.ai/" }).baseUrl, "https://intake.hellojade.ai");
});

// ---------------------------------------------------------------- checkKey

test("checkKey: 422 means the key is valid and nothing was stored", async () => {
  const r = await client().checkKey({ requestId: "kc-1" });
  assert.deepEqual(r, { valid: true, status: 422, requestId: "kc-1", required: ["first_name", "last_name", "phone"] });
  const req = stub.requests[0];
  assert.equal(req.method, "POST");
  assert.equal(req.path, "/v1/intake");
  assert.equal(req.headers["x-api-key"], "test-key-valid");
  assert.equal(req.headers["x-request-id"], "kc-1");
  assert.equal(req.headers["idempotency-key"], undefined, "the key check must not spend an Idempotency-Key");
  assert.deepEqual(req.body, {});
});

test("checkKey: 401 means the key is wrong, and it does not throw", async () => {
  const r = await client({ apiKey: "nope" }).checkKey();
  assert.equal(r.valid, false);
  assert.equal(r.status, 401);
  assert.equal(typeof r.requestId, "string");
  assert.deepEqual(r.required, []);
});

test("checkKey: a 503 is retried and then throws ApiError when exhausted", async () => {
  stub.push(...Array(5).fill({ status: 503, body: { error: "not_accepting" } }));
  await assert.rejects(client().checkKey(), (e) => e instanceof ApiError && e.status === 503 && e.code === "not_accepting");
  assert.equal(stub.requests.length, 5);
});

// ---------------------------------------------------------------- submitLead

test("submitLead: 202 accepted with headers and body exactly as the contract says", async () => {
  const c = client({ userAgent: "test-agent/1" });
  const r = await c.submitLead({ ...LEAD, project_area: "roof" }, { idempotencyKey: "A-1", requestId: "r-1" });
  assert.equal(r.status, "accepted");
  assert.match(r.event_id, /^evt_/);
  assert.deepEqual(r.flags, []);
  assert.equal(r.source, "stub-partner");
  assert.equal(r.requestId, "r-1");
  const req = stub.requests[0];
  assert.equal(req.headers["content-type"], "application/json");
  assert.equal(req.headers["accept"], "application/json");
  assert.equal(req.headers["user-agent"], "test-agent/1");
  assert.equal(req.headers["idempotency-key"], "A-1");
  assert.equal(req.headers["x-request-id"], "r-1");
  assert.deepEqual(req.body, { ...LEAD, project_area: "roof" });
});

test("submitLead: 200 duplicate is success with the original event_id", async () => {
  stub.push({ status: 200, body: { event_id: "evt_first", status: "duplicate", received_at: "2026-09-03T00:00:00Z", flags: [] } });
  const r = await client().submitLead(LEAD, { idempotencyKey: "A-1" });
  assert.equal(r.status, "duplicate");
  assert.equal(r.event_id, "evt_first");
});

test("submitLead: flags come back on a success and are always an array", async () => {
  stub.push({ status: 202, body: { event_id: "evt_x", status: "accepted", received_at: "t", flags: ["phone_unnormalized"] } });
  const r = await client().submitLead({ ...LEAD, phone: "call me" }, { idempotencyKey: "A-2" });
  assert.deepEqual(r.flags, ["phone_unnormalized"]);
  stub.push({ status: 202, body: { event_id: "evt_y", status: "accepted", received_at: "t" } });
  const r2 = await client().submitLead(LEAD, { idempotencyKey: "A-3" });
  assert.deepEqual(r2.flags, []);
});

test("submitLead: idempotencyNamespace prefixes the key", async () => {
  await client({ idempotencyNamespace: "acme-leads" }).submitLead(LEAD, { idempotencyKey: "1234" });
  assert.equal(stub.requests[0].headers["idempotency-key"], "acme-leads:1234");
});

test("submitLead: a generated X-Request-Id is sent, and is the same on every attempt", async () => {
  stub.push({ status: 503, body: { error: "not_accepting" } });
  const r = await client().submitLead(LEAD, { idempotencyKey: "A-4" });
  assert.equal(r.status, "accepted");
  assert.equal(stub.requests.length, 2);
  const ids = stub.requests.map((q) => q.headers["x-request-id"]);
  assert.match(ids[0], /^[0-9a-f-]{36}$/);
  assert.equal(ids[0], ids[1]);
  assert.equal(stub.requests[0].headers["idempotency-key"], stub.requests[1].headers["idempotency-key"]);
});

test("submitLead: idempotencyKey is required", async () => {
  await assert.rejects(client().submitLead(LEAD, {}), TypeError);
  await assert.rejects(client().submitLead(LEAD), TypeError);
  assert.equal(stub.requests.length, 0);
});

test("submitLead: refuses `source` and a non-object `extra` client-side", async () => {
  await assert.rejects(client().submitLead({ ...LEAD, source: "angi" }, { idempotencyKey: "k" }), /do not send `source`/);
  await assert.rejects(client().submitLead({ ...LEAD, extra: "x" }, { idempotencyKey: "k" }), /reserved key/);
  await client().submitLead({ ...LEAD, extra: { ok: true } }, { idempotencyKey: "k" });
  assert.equal(stub.requests.length, 1);
});

test("submitLead: apiKey is required", async () => {
  await assert.rejects(new IntakeClient({ baseUrl: stub.url }).submitLead(LEAD, { idempotencyKey: "k" }), /apiKey is required/);
});

test("submitLead: 422 throws ValidationError with EVERY failing field, no retry", async () => {
  await assert.rejects(
    client().submitLead({ first_name: "" }, { idempotencyKey: "A-5", requestId: "r-422" }),
    (e) => {
      assert.ok(e instanceof ValidationError);
      assert.ok(e instanceof ApiError);
      assert.equal(e.status, 422);
      assert.equal(e.code, "validation_failed");
      assert.deepEqual(e.fields, { first_name: "required", last_name: "required", phone: "required" });
      assert.equal(e.requestId, "r-422");
      assert.match(e.message, /3 fields/);
      return true;
    },
  );
  assert.equal(stub.requests.length, 1);
});

test("submitLead: 422 out_of_range on cost is surfaced verbatim", async () => {
  stub.push({ status: 422, body: { error: "validation_failed", request_id: "x", fields: { cost: "out_of_range" } } });
  await assert.rejects(client().submitLead({ ...LEAD, cost: 0 }, { idempotencyKey: "k" }), (e) => e.fields.cost === "out_of_range");
});

test("submitLead: 400 invalid_json throws ApiError, no retry", async () => {
  stub.push({ status: 400, body: { error: "invalid_json", request_id: "r-400" } });
  await assert.rejects(client().submitLead(LEAD, { idempotencyKey: "k", requestId: "r-400" }), (e) => e instanceof ApiError && e.status === 400 && e.code === "invalid_json" && e.requestId === "r-400");
  assert.equal(stub.requests.length, 1);
});

test("submitLead: 401 unauthorized throws ApiError, no retry", async () => {
  await assert.rejects(client({ apiKey: "revoked" }).submitLead(LEAD, { idempotencyKey: "k" }), (e) => e instanceof ApiError && e.status === 401 && e.code === "unauthorized");
  assert.equal(stub.requests.length, 1);
});

test("submitLead: 413 body_too_large throws ApiError with the header request id", async () => {
  stub.push({ status: 413, body: { error: "body_too_large" }, headers: { "x-request-id": "edge-413" } });
  await assert.rejects(client().submitLead(LEAD, { idempotencyKey: "k" }), (e) => e.status === 413 && e.code === "body_too_large" && e.requestId === "edge-413");
  assert.equal(stub.requests.length, 1);
});

test("submitLead: 429 waits Retry-After and does not consume a delivery attempt", async () => {
  stub.push({ status: 429, body: { error: "rate_limited" }, headers: { "retry-after": "3" } });
  const r = await client({ retry: { maxAttempts: 1 } }).submitLead(LEAD, { idempotencyKey: "k" });
  assert.equal(r.status, "accepted");
  assert.equal(stub.requests.length, 2);
  assert.deepEqual(sleeps, [3000]);
});

test("submitLead: 429 wait grows with our own backoff when Retry-After is only the floor", async () => {
  stub.push(
    { status: 429, body: { error: "rate_limited" }, headers: { "retry-after": "1" } },
    { status: 429, body: { error: "rate_limited" }, headers: { "retry-after": "1" } },
    { status: 429, body: { error: "rate_limited" }, headers: { "retry-after": "1" } },
  );
  await client().submitLead(LEAD, { idempotencyKey: "k" });
  assert.deepEqual(sleeps, [1000, 2000, 4000]);
});

test("submitLead: too many 429s throws RateLimitedError", async () => {
  stub.push(...Array(3).fill({ status: 429, body: { error: "rate_limited" }, headers: { "retry-after": "2" } }));
  await assert.rejects(client({ retry: { maxRateLimitWaits: 2 } }).submitLead(LEAD, { idempotencyKey: "k" }), (e) => e instanceof RateLimitedError && e.status === 429 && e.retryAfter === 2);
  assert.equal(stub.requests.length, 3);
});

test("submitLead: 503 retries with exponential backoff and then succeeds", async () => {
  stub.push({ status: 503, body: { error: "not_accepting" } }, { status: 503, body: { error: "not_accepting" } });
  const r = await client().submitLead(LEAD, { idempotencyKey: "k" });
  assert.equal(r.status, "accepted");
  assert.equal(stub.requests.length, 3);
  assert.deepEqual(sleeps, [1000, 2000]);
});

test("submitLead: 5xx exhaustion throws the last ApiError after maxAttempts", async () => {
  stub.push(...Array(5).fill({ status: 502, body: "bad gateway", headers: { "content-type": "text/plain" } }));
  await assert.rejects(client().submitLead(LEAD, { idempotencyKey: "k" }), (e) => e instanceof ApiError && e.status === 502 && e.code === null);
  assert.equal(stub.requests.length, 5);
  assert.deepEqual(sleeps, [1000, 2000, 4000, 8000]);
});

test("submitLead: backoff is capped at maxDelayMs plus jitter", async () => {
  stub.push(...Array(4).fill({ status: 503, body: {} }));
  await client({ retry: { maxDelayMs: 2500, jitterMs: 100 }, random: () => 1 }).submitLead(LEAD, { idempotencyKey: "k" });
  assert.deepEqual(sleeps, [1100, 2100, 2600, 2600]);
});

test("submitLead: timeout is retried and surfaces as TransportError when exhausted", async () => {
  stub.hang(2);
  await assert.rejects(
    client({ timeoutMs: 50, retry: { maxAttempts: 2 } }).submitLead(LEAD, { idempotencyKey: "k" }),
    (e) => e instanceof TransportError && e.attempts === 2 && /timeout after 50ms/.test(String(e.cause?.message ?? e.cause)),
  );
  assert.equal(stub.requests.length, 2);
});

test("submitLead: connection refused is a TransportError", async () => {
  const dead = new IntakeClient({ baseUrl: "http://127.0.0.1:1", apiKey: "k", sleep: noSleep, random: zero, retry: { maxAttempts: 2 } });
  await assert.rejects(dead.submitLead(LEAD, { idempotencyKey: "k" }), (e) => e instanceof TransportError && e.attempts === 2);
});

test("submitLead: a caller's AbortSignal aborts immediately and is not retried", async () => {
  stub.hang(1);
  const ac = new AbortController();
  const p = client({ timeoutMs: 5000 }).submitLead(LEAD, { idempotencyKey: "k", signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(p, (e) => e.name === "AbortError" || /abort/i.test(e.message));
  assert.equal(stub.requests.length, 1);
  assert.deepEqual(sleeps, []);
});

// ---------------------------------------------------------------- vocabulary / health

test("vocabulary: unauthenticated GET, parsed", async () => {
  const v = await new IntakeClient({ baseUrl: stub.url }).vocabulary();
  assert.equal(stub.requests[0].method, "GET");
  assert.equal(stub.requests[0].path, "/v1/vocabulary");
  assert.equal(stub.requests[0].headers["x-api-key"], undefined);
  assert.deepEqual(v.project_service, ["replacement", "repair", "remodel", "maintain"]);
  assert.deepEqual(v.required, ["first_name", "last_name", "phone"]);
  assert.equal(v.project_area[0].area, "roof");
});

test("vocabulary: 503 is retried", async () => {
  stub.push({ status: 503, body: "" });
  const v = await client().vocabulary();
  assert.equal(v.project_area.length, 2);
  assert.equal(stub.requests.length, 2);
});

test("health: 200 and 503 both return the body; other statuses throw", async () => {
  const h = await client().health();
  assert.equal(h.ok, true);
  assert.equal(h.store_writable, true);
  assert.equal(h.oldest_pending_age_s, null);
  stub.push({ status: 503, body: { ok: false, store_writable: false, pending: 3, dead: 1, oldest_pending_age_s: 42 } });
  const bad = await client().health();
  assert.equal(bad.ok, false);
  assert.equal(bad.pending, 3);
  assert.equal(bad.oldest_pending_age_s, 42);
  stub.push({ status: 500, body: "" });
  await assert.rejects(client().health(), (e) => e instanceof ApiError && e.status === 500);
  assert.equal(stub.requests.length, 3, "health never retries");
});

// ---------------------------------------------------------------- helpers

test("parseRetryAfter: seconds, HTTP-date, garbage", () => {
  assert.equal(parseRetryAfter("7"), 7);
  assert.equal(parseRetryAfter(null), 1);
  assert.equal(parseRetryAfter("soon"), 1);
  const now = Date.parse("2026-09-03T12:00:00Z");
  assert.equal(parseRetryAfter("Thu, 03 Sep 2026 12:00:10 GMT", now), 10);
  assert.equal(parseRetryAfter("Thu, 03 Sep 2026 11:00:00 GMT", now), 0);
});

test("backoffMs: exponential with jitter, capped", () => {
  assert.equal(backoffMs(DEFAULT_RETRY, 1, () => 0), 1000);
  assert.equal(backoffMs(DEFAULT_RETRY, 3, () => 0), 4000);
  assert.equal(backoffMs(DEFAULT_RETRY, 10, () => 0), 30_000);
  assert.equal(backoffMs(DEFAULT_RETRY, 1, () => 1), 1500);
});
