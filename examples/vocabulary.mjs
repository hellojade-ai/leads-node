// The project_area vocabulary lives in a database and grows without a deploy —
// fetch it, never hard-code it. Unauthenticated.
import { IntakeClient } from "@hellojade/intake";

const client = new IntakeClient();
const v = await client.vocabulary();
console.log("required:", v.required.join(", "));
console.log("project_service:", v.project_service.join(", "));
for (const t of v.project_area) console.log(`  ${t.area.padEnd(16)} ${t.status}`);
