// A minimal server-side relay: your site's browser form posts here (same origin, no key
// in the page), and this forwards it to hellojade with the key from the environment.
// Pair it with the browser kit's <hellojade-lead-form relay-url="/api/lead">:
// https://github.com/hellojade-ai/leads-js
//
// Run: HELLOJADE_API_KEY=... node examples/browser-relay.mjs   (listens on 127.0.0.1:8080)
import { createServer } from "node:http";
import { IntakeClient, ApiError, ValidationError } from "@hellojade/intake";

const client = new IntakeClient({
  apiKey: process.env.HELLOJADE_API_KEY,
  idempotencyNamespace: "my-site",
});

createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/api/lead") {
    res.writeHead(404).end();
    return;
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  let lead;
  try {
    lead = JSON.parse(raw);
  } catch {
    res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_json" }));
    return;
  }
  delete lead.source; // never forward a source; the key is the source
  const idempotencyKey = req.headers["idempotency-key"]; // the form mints one per fill
  if (typeof idempotencyKey !== "string" || !idempotencyKey) {
    res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "missing_idempotency_key" }));
    return;
  }
  try {
    const accepted = await client.submitLead(lead, {
      idempotencyKey,
      requestId: typeof req.headers["x-request-id"] === "string" ? req.headers["x-request-id"] : undefined,
    });
    res.writeHead(accepted.status === "duplicate" ? 200 : 202, { "content-type": "application/json" });
    res.end(JSON.stringify(accepted));
  } catch (err) {
    if (err instanceof ValidationError) {
      res.writeHead(422, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "validation_failed", fields: err.fields, request_id: err.requestId }));
    } else if (err instanceof ApiError) {
      // Do not leak our key problem to the visitor; log request_id server-side.
      console.error("intake rejected", err.status, err.code, err.requestId);
      res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: "upstream" }));
    } else {
      console.error("intake unreachable", err);
      res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: "not_accepting" }));
    }
  }
}).listen(8080, "127.0.0.1", () => console.log("relay on http://127.0.0.1:8080/api/lead"));
