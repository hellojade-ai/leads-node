// Submit one lead with every rule from the integration brief applied.
// Run: HELLOJADE_API_KEY=... node examples/submit-lead.mjs
import { IntakeClient, ValidationError, ApiError, RateLimitedError, TransportError } from "@hellojade/intake";

const client = new IntakeClient({
  apiKey: process.env.HELLOJADE_API_KEY,
  // Rule 3: dedupe is per TENANT, not per key. Namespace your ids to something only you use.
  idempotencyNamespace: "acme-leads",
});

// Your system's own record. Its id is the Idempotency-Key — stable across retries.
const record = {
  id: "1234",
  lead: {
    first_name: "Dana",
    last_name: "Whitfield",
    phone: "(630) 555-0142",
    email: "dana.whitfield@example.com",
    street_address: "418 N Maple St",
    city: "Naperville",
    state: "IL",
    zip: "60540",
    project_area: "roof", // send YOUR term; an unrecognized one is stored and flagged, not rejected
    project_service: "replacement",
    project_details: "Hail damage on the south slope, insurance claim already filed.",
    external_id: "1234",
    partner_job_id: "XZ-1", // unmodeled fields are preserved under `extra`
  },
};

try {
  const accepted = await client.submitLead(record.lead, {
    idempotencyKey: record.id,
    requestId: `acme-leads/${record.id}`,
  });
  // 202 "accepted" or 200 "duplicate" — both mean it is on hellojade's disk. Store event_id.
  console.log(accepted.status, accepted.event_id, "source:", accepted.source);
  if (accepted.flags.length) console.log("flags (not errors):", accepted.flags.join(", "));
} catch (err) {
  if (err instanceof ValidationError) {
    // Every failing field at once. Fix the body; do not retry it unchanged.
    console.error("validation failed:", err.fields, "request_id:", err.requestId);
  } else if (err instanceof RateLimitedError) {
    console.error("rate limited for too long; last Retry-After:", err.retryAfter);
  } else if (err instanceof ApiError) {
    // 400 / 401 / 413 / other 4xx: a configuration or payload problem on our side. Log request_id.
    console.error(`rejected: ${err.status} ${err.code} request_id=${err.requestId}`);
  } else if (err instanceof TransportError) {
    console.error(`unreachable after ${err.attempts} attempts:`, err.cause);
  } else {
    throw err;
  }
  process.exitCode = 1;
}
