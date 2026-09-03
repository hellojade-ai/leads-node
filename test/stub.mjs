// A scriptable stand-in for intake.hellojade.ai. Tests push responses onto a queue;
// every request is recorded (method, path, headers, parsed body) for assertions.
import { createServer } from "node:http";

export async function startStub() {
  const queue = [];
  const requests = [];
  let hangNext = 0;

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      requests.push({ method: req.method, path: req.url, headers: req.headers, body, raw });
      if (hangNext > 0) {
        hangNext -= 1;
        return; // never answer — the client's timeout must fire
      }
      const next = queue.shift() ?? defaultResponse(req, body);
      const headers = { "content-type": "application/json", ...(next.headers ?? {}) };
      const rid = req.headers["x-request-id"];
      if (rid && !("x-request-id" in headers)) headers["x-request-id"] = rid;
      res.writeHead(next.status, headers);
      res.end(next.body === undefined ? "" : typeof next.body === "string" ? next.body : JSON.stringify(next.body));
    });
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    push(...responses) {
      queue.push(...responses);
    },
    hang(n = 1) {
      hangNext += n;
    },
    reset() {
      queue.length = 0;
      requests.length = 0;
      hangNext = 0;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

// What the real edge does when nothing is scripted: authenticate, then validate.
function defaultResponse(req, body) {
  if (req.url === "/healthz") {
    return { status: 200, body: { ok: true, store_writable: true, pending: 0, dead: 0, oldest_pending_age_s: null } };
  }
  if (req.url === "/v1/vocabulary") {
    return {
      status: 200,
      body: {
        project_area: [
          { area: "roof", status: "confirmed" },
          { area: "solar", status: "proposed" },
        ],
        project_service: ["replacement", "repair", "remodel", "maintain"],
        required: ["first_name", "last_name", "phone"],
      },
    };
  }
  if (req.method !== "POST") return { status: 405, body: { error: "method_not_allowed", request_id: "" } };
  if (req.headers["x-api-key"] !== "test-key-valid") {
    return { status: 401, body: { error: "unauthorized", request_id: "stub-rid" } };
  }
  if (!body || typeof body !== "object") return { status: 400, body: { error: "invalid_json", request_id: "stub-rid" } };
  const fields = {};
  for (const f of ["first_name", "last_name", "phone"]) if (!body[f]) fields[f] = "required";
  if (Object.keys(fields).length) {
    return { status: 422, body: { error: "validation_failed", request_id: "stub-rid", fields } };
  }
  const flags = [];
  const known = new Set([
    "first_name", "last_name", "phone", "email", "street_address", "city", "state", "zip", "country",
    "project_area", "project_service", "project_material", "project_details", "external_id", "cost",
  ]);
  if (Object.keys(body).some((k) => !known.has(k))) flags.push("extra_fields_preserved");
  return {
    status: 202,
    body: {
      event_id: "evt_stub_" + (requestsSeen++).toString(36).padStart(4, "0"),
      status: "accepted",
      received_at: "2026-09-03T00:00:00Z",
      source: "stub-partner",
      flags,
    },
  };
}
let requestsSeen = 1;
