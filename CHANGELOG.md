# Changelog

All notable changes to `@hellojade/intake` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-09-03

### Added

- `IntakeClient` with `checkKey()`, `submitLead()`, `vocabulary()` and `health()`.
- Retry policy that follows the integration brief: transport errors and 5xx retry with
  exponential backoff and jitter; 429 waits for `Retry-After` (or our own growing backoff,
  whichever is longer) without consuming a delivery attempt; every other 4xx throws at once.
- Typed errors: `ApiError`, `ValidationError` (with `fields`), `RateLimitedError`
  (with `retryAfter`), `TransportError` (with `attempts` and `cause`).
- `idempotencyNamespace` option so `Idempotency-Key` values cannot collide with other
  lead sources on the same tenant.
- Client-side refusal of a `source` field and of a non-object `extra` field.
- Dual ESM + CommonJS builds with type declarations; zero runtime dependencies; Node 18+.
- Tests against a local HTTP stub covering every documented status.

[0.1.0]: https://github.com/hellojade-ai/hellojade-node/releases/tag/v0.1.0
