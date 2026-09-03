// The CommonJS build must load with require() and expose the same surface.
const { test } = require("node:test");
const assert = require("node:assert/strict");

test("CJS build exposes the same surface as ESM", async () => {
  const cjs = require("../dist/cjs/index.js");
  const esm = await import("../dist/esm/index.js");
  for (const name of ["IntakeClient", "ApiError", "ValidationError", "RateLimitedError", "TransportError", "IntakeError", "VERSION", "DEFAULT_BASE_URL", "parseRetryAfter"]) {
    assert.ok(name in cjs, `cjs missing ${name}`);
    assert.ok(name in esm, `esm missing ${name}`);
  }
  assert.equal(cjs.VERSION, esm.VERSION);
  const c = new cjs.IntakeClient({ apiKey: "x" });
  assert.equal(c.baseUrl, "https://intake.hellojade.ai");
  assert.equal(c.retry.maxAttempts, 5);
  assert.equal(c.timeoutMs, 20000);
});
