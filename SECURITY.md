# Security

## Reporting a vulnerability

If you find a security problem in this client or in the hellojade Partner Intake API,
email **security@hellojade.ai** or contact the person at hellojade who issued your API
key. Please do not open a public issue for security reports. We aim to acknowledge reports
within two business days.

## Your API key

- **Never paste your key** into an issue, a pull request, a chat message, an email, a
  ticket, or a shared terminal session. hellojade stores only a hash of the key; a lost key
  is rotated, never looked up.
- If a key has been exposed anywhere, say so immediately and ask for a rotation. A
  replacement is issued so you can cut over before the old one is revoked.
- Keep the key in an environment variable or a secret store — never in source, never in
  a URL, never in a log line. This client never logs it and never includes it in an error
  message.
- A key belongs on a **server**. Do not ship it to a browser or a mobile app, where every
  user can read it. For browser forms, relay through your own backend (see
  `examples/browser-relay.mjs` and the browser kit at
  <https://github.com/hellojade-ai/leads-js>).

## What this client sends

Exactly what you pass to `submitLead`, plus the headers `X-API-Key`, `Idempotency-Key`,
`X-Request-Id`, `Content-Type`, `Accept` and `User-Agent`. It sends nothing else and
collects no telemetry.

## Supported versions

Only the latest minor release receives fixes.
