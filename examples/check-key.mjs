// Step one of every integration: prove the key works without creating a lead.
// Run: HELLOJADE_API_KEY=... node examples/check-key.mjs
import { IntakeClient } from "@hellojade/intake";

const client = new IntakeClient({ apiKey: process.env.HELLOJADE_API_KEY });
const r = await client.checkKey();

if (r.valid) {
  console.log(`key is valid (422, nothing stored). required fields: ${r.required.join(", ")}`);
} else {
  console.error(`key rejected (${r.status}). request_id=${r.requestId} — check the header value for whitespace, then ask hellojade whether the key is active.`);
  process.exitCode = 1;
}
