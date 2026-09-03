# @hellojade/intake

Node.js client for the **hellojade Partner Intake API** — the one endpoint a lead source
POSTs to when it has a lead for a hellojade customer.

- TypeScript, dual **ESM + CommonJS** builds, full type declarations
- **Node 18+**, uses the global `fetch`, **zero runtime dependencies**
- The integration brief's rules are built in: idempotency, the retry policy, `Retry-After`,
  every failing field on a `422`, and a refusal to send `source`

| | |
|---|---|
| API documentation + live playground | <https://intake.hellojade.ai/api> |
| OpenAPI contract | <https://intake.hellojade.ai/api/openapi.json> |
| Integration brief (read it once, front to back) | <https://intake.hellojade.ai/api/INTEGRATION.md> |
| Becoming a lead provider | <https://hellojade.ai/developers/provide-leads> |
| Browser kit (web component + relay pattern) | <https://github.com/hellojade-ai/hellojade-js> |
| Python kit | <https://github.com/hellojade-ai/hellojade-python> |

## Install

This package is **not published to npm yet**. Install it straight from GitHub, pinned to a tag:

```sh
npm install github:hellojade-ai/hellojade-node#v0.1.1
```

The `prepack`/`prepare` step builds `dist/` on install, so you get the compiled ESM and CJS
output either way. (When it is published, the command will be `npm install @hellojade/intake`;
see [Publishing](#publishing) for how that happens.)

## Quickstart

### 1. Prove the key works — before you write anything else

```js
import { IntakeClient } from "@hellojade/intake";

const client = new IntakeClient({ apiKey: process.env.HELLOJADE_API_KEY });

const check = await client.checkKey();
// { valid: true, status: 422, requestId: "…", required: ["first_name", "last_name", "phone"] }
```

`checkKey()` sends an empty body with your key. The API authenticates **before** it
validates, so a `422` proves the key is valid and that **nothing was stored** — no lead, no
email, no CRM row. A `401` means the key is wrong; `valid` is `false` and nothing throws.
Run this before you write code and again on the day you go live.

### 2. Submit a lead

```js
import { IntakeClient, ValidationError, ApiError, RateLimitedError, TransportError } from "@hellojade/intake";

const client = new IntakeClient({
  apiKey: process.env.HELLOJADE_API_KEY,
  // Dedupe is scoped to the CUSTOMER, not to your key. Namespace your ids so they
  // cannot collide with another lead source's — see "Idempotency" below.
  idempotencyNamespace: "acme-leads",
});

try {
  const accepted = await client.submitLead(
    {
      first_name: "Dana",
      last_name: "Whitfield",
      phone: "(630) 555-0142",
      email: "dana.whitfield@example.com",
      street_address: "418 N Maple St",
      city: "Naperville",
      state: "IL",
      zip: "60540",
      project_area: "roof",
      project_service: "replacement",
      project_details: "Hail damage on the south slope, insurance claim already filed.",
      external_id: "1234",
    },
    {
      idempotencyKey: "1234",              // YOUR stable id for this lead — required
      requestId: "acme-leads/1234",        // optional; echoed on every response and error
    },
  );

  accepted.status;    // "accepted" (202) or "duplicate" (200) — both mean it is on disk
  accepted.event_id;  // store this against your lead record
  accepted.source;    // your key's registered label; you never send it
  accepted.flags;     // always an array; non-fatal observations such as "phone_unnormalized"
} catch (err) {
  if (err instanceof ValidationError) console.error(err.fields);      // EVERY failing field
  else if (err instanceof RateLimitedError) console.error(err.retryAfter);
  else if (err instanceof ApiError) console.error(err.status, err.code, err.requestId);
  else if (err instanceof TransportError) console.error(err.attempts, err.cause);
  else throw err;
}
```

CommonJS works too:

```js
const { IntakeClient } = require("@hellojade/intake");
```

More in [`examples/`](examples/): the key check, a full submit, fetching the vocabulary, and a
30-line **server-side relay** for browser forms.

## API

### `new IntakeClient(options?)`

| option | default | notes |
|---|---|---|
| `baseUrl` | `https://intake.hellojade.ai` | must be `https` (nothing listens on port 80, and there is no redirect); `http` is allowed only for `127.0.0.1` / `localhost` |
| `apiKey` | — | needed for `checkKey` and `submitLead`; read it from your environment or secret store |
| `fetch` | `globalThis.fetch` | inject your own for tests or proxies |
| `timeoutMs` | `20000` | per attempt, via `AbortController`; the server bounds its own handler at 20 s |
| `userAgent` | `@hellojade/intake/<version> node/<version>` | |
| `retry` | see below | partial overrides of the retry policy |
| `idempotencyNamespace` | — | when set, every `Idempotency-Key` is sent as `<namespace>:<key>` |
| `sleep`, `random` | `setTimeout`, `Math.random` | injectable so tests run without waiting |

### `client.checkKey({ requestId?, signal? }) → Promise<KeyCheck>`

Resolves `{ valid, status, requestId, required }`. Never throws on `401` or `422`. Throws
`ApiError` for anything else the retry policy could not recover from.

### `client.submitLead(lead, { idempotencyKey, requestId?, signal? }) → Promise<Accepted>`

Resolves on `202` (`status: "accepted"`) and `200` (`status: "duplicate"`, with the
**original** `event_id`). `idempotencyKey` is required — see [Idempotency](#idempotency).
Throws `TypeError` before any request if the lead contains `source` (your key is the source)
or an `extra` that is not an object (`extra` is reserved; send additional fields at the top
level and the API collects them for you).

### `client.vocabulary({ signal? }) → Promise<Vocabulary>`

`GET /v1/vocabulary` — unauthenticated. `project_area` is a controlled vocabulary held in a
**database table** that grows without a deploy, so fetch it rather than hard-coding it. An
unrecognized value is never a rejection; it is stored verbatim and flagged.

### `client.health({ signal? }) → Promise<Health>`

`GET /healthz`. Returns the body on both `200` and `503` — read `ok`. Never retries.

### Types

`Lead`, `Accepted`, `KeyCheck`, `Vocabulary`, `VocabularyTerm`, `Health`, `RetryPolicy`,
`IntakeClientOptions`, `SubmitOptions`, `LeadFlag`, `ProjectService` — all exported.

`Lead` requires `first_name`, `last_name` and `phone`. Everything else is optional; send what
you have and nothing you do not (`"email": "none@none.com"` is worse than omitting it).
`cost`, when present, is US dollars in `0.01`–`999.99` — omit it if there is no charge, never
send `0`.

## Errors

| status | `error` code | thrown as | retried? | what to do |
|---|---|---|---|---|
| `202` | — | resolves, `status: "accepted"` | — | store `event_id` |
| `200` | — | resolves, `status: "duplicate"` | — | same `event_id` as the first time; a success |
| `400` | `invalid_json` | `ApiError` | no | fix the body (an `extra` that is not an object does this) |
| `401` | `unauthorized` | `ApiError` | no | configuration problem — run `checkKey()` |
| `413` | `body_too_large` | `ApiError` | no | over 64 KiB; trim `project_details` |
| `422` | `validation_failed` | `ValidationError` with `fields` | no | read **every** entry in `fields`, fix, resend |
| `429` | `rate_limited` | waits, then `RateLimitedError` if it never clears | yes, honoring `Retry-After` | nothing — the client waits; a wait does not consume an attempt |
| `5xx` | e.g. `not_accepting` | `ApiError` after the attempts are exhausted | yes, with backoff | nothing — this is hellojade, not you |
| network / timeout | — | `TransportError` with `cause` | yes, with backoff | check `https://`, egress, DNS |

Every error carries `requestId` (from the `X-Request-Id` response header, falling back to the
body). Log it on every failure — when there is no `event_id`, it is the only handle support
can use to find your request.

**Flags are not errors.** `phone_unnormalized`, `project_area_unknown`,
`project_service_unknown`, `email_shape_suspect`, `extra_fields_preserved` and
`country_unrecognized` all arrive on a **successful** response. Do not retry on a flag.

## Retry policy

The default policy follows rule 5 of the brief exactly:

| | |
|---|---|
| transport error or timeout | retry with backoff, up to `maxAttempts` (**5**), then `TransportError` |
| `5xx` | retry with backoff, up to `maxAttempts`, then `ApiError` |
| `429` | wait `max(Retry-After, backoff(n))`, **without consuming an attempt**; after `maxRateLimitWaits` (**10**) throw `RateLimitedError` |
| any other `4xx` | throw immediately — retrying an unchanged `422` only burns your rate limit |

Backoff is `min(maxDelayMs, baseDelayMs × 2^(n−1)) + random × jitterMs` with defaults
`1000`, `30000` and `500` ms. The jitter matters: without it a fleet of workers recovering
from the same outage retries in lockstep. Override any of these with `retry: { … }`.
`Retry-After` is currently `1` on both of hellojade's limiters; it is a floor, not a
strategy, which is why the client's own backoff grows across repeated `429`s.

## Idempotency

**Always send an `Idempotency-Key`, and make it your own stable id for the lead** — the id
your system already uses, so a retry of the same lead carries the same key. Not a timestamp,
not a UUID minted at send time. That is why `submitLead` requires it. A repeat returns `200`
with the original `event_id`; a new key returns `202`. Both are success, and both are safe to
retry as often as you like.

**Namespace it.** Dedupe is scoped to the hellojade **customer**, and one customer may have
dozens of lead sources posting under dozens of keys. If you send `"1234"` and another source
already sent `"1234"`, you get a `200` pointing at *their* event and your lead is never
stored. Set `idempotencyNamespace: "acme-leads"` and the client sends `acme-leads:1234`.

`X-Request-Id` is different: it is for tracing, not deduplication. Pass `requestId` (any
string up to 64 characters) and it appears in the response header, in every error body, and
in hellojade's access log. If you do not, the client generates one per call and sends the same
value on every retry of that call.

## Definition of done

From the brief, all observable with this client:

- [ ] `checkKey()` resolves `valid: true` against the key you will ship with
- [ ] a lead with `first_name`, `last_name` and `phone` resolves `"accepted"`
- [ ] the same lead twice with the same `idempotencyKey` resolves `"accepted"` then `"duplicate"` with the same `event_id`
- [ ] your keys are namespaced and stable across retries
- [ ] a lead missing all three required fields throws `ValidationError` naming all three in `fields`
- [ ] the API key appears in no log line, error message, stack trace or committed file — grep for it
- [ ] `event_id` is stored on success and `requestId` is logged on every failure

## Development

```sh
npm ci
npm run typecheck   # tsc --noEmit
npm run build       # dist/esm + dist/cjs
npm test            # builds, then runs node:test against a local HTTP stub
```

The tests never touch `intake.hellojade.ai`; `test/stub.mjs` is a scriptable stand-in that
records every request. CI runs the suite on Node 18, 20 and 22
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

## Publishing

Nothing here is on npm. When hellojade decides to publish, a maintainer with access to the
`@hellojade` npm scope runs, from a clean checkout of a tagged commit:

```sh
npm ci && npm test
npm pack --dry-run          # confirm only dist/, README, LICENSE, CHANGELOG ship
npm publish --access public
```

`prepack` rebuilds `dist/` first. Until then, install from the GitHub tag as shown above.

## License

[MIT](LICENSE) © 2026 hellojade
