# Contributing

Thanks for helping make the hellojade Partner Intake API easier to integrate.

## Ground rules

- **The API contract is the source of truth**, not this client. If the client and
  <https://intake.hellojade.ai/api/openapi.json> disagree, the client is wrong — open an
  issue that quotes the spec.
- **Zero runtime dependencies.** The client uses Node's global `fetch`, `AbortController`
  and `node:crypto` and nothing else. A pull request that adds a runtime dependency will
  be asked to remove it.
- **Never commit a key.** Examples read `HELLOJADE_API_KEY` from the environment. Grep
  your diff for anything that looks like a credential before you push.
- **Never post a real-looking lead to production while developing.** The tests run
  against a local stub (`test/stub.mjs`). If you need a live round trip, use
  `checkKey()` — it stores nothing — or ask hellojade for a sandbox key.
- American English in code, comments and docs.

## Development

```sh
npm ci
npm run typecheck   # tsc --noEmit
npm run build       # dist/esm + dist/cjs
npm test            # builds, then node --test on test/*.test.*
```

Node 18, 20 and 22 are supported and exercised in CI (`.github/workflows/ci.yml`).

## Adding a test

`test/stub.mjs` is a scriptable stand-in for the intake edge. Push the responses you want
onto its queue and assert on `stub.requests`, which records method, path, headers and the
parsed body of every request. The default handler (no scripted response) behaves like the
real edge: it authenticates, then validates, then accepts.

## Pull requests

1. One change per pull request, with a test that fails without it.
2. Update `CHANGELOG.md` under an "Unreleased" heading.
3. CI must be green on all three Node versions.

## Releasing

Maintainers bump `version` in `package.json` and `VERSION` in `src/client.ts`, move the
Unreleased notes under a dated heading, tag `vX.Y.Z`, and push the tag. Publishing to npm
is a separate, deliberate step — see the README.
