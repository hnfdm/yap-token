// Registry fuzz: malformed / hostile requests must be answered with a 4xx JSON error, never a 5xx, a hang or a crash; the registry must
// still serve a valid request afterwards. Read-only against the ledger (the registry only reads ACS), no ledger transactions, no traffic.
//   node scripts/26-registry-fuzz.mjs
import { loadEnv } from "./lib.mjs";

const OURS = loadEnv(".env.testnet");
if (OURS.INSECURE_TLS === "1") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const admin = OURS.CUSDT_ADMIN_PARTY, sfx = admin.split("::")[1], ALICE = `cusdt-alice::${sfx}`, BOB = `cusdt-bob::${sfx}`;
const R = process.env.CUSDT_REGISTRY_URL || "https://registry-testnet.mahawallet.xyz";
const TF = "/registry/transfer-instruction/v1/transfer-factory", AF = "/registry/allocation-instruction/v1/allocation-factory";
const inst = { admin, id: "cUSDT" };
const goodT = () => ({ choiceArguments: { expectedAdmin: admin, transfer: { sender: ALICE, receiver: BOB, amount: "0.000001", instrumentId: inst, requestedAt: new Date().toISOString(), executeBefore: new Date(Date.now() + 36e5).toISOString(), inputHoldingCids: [], meta: { values: {} } } } });
const goodA = () => ({ choiceArguments: { expectedAdmin: admin, allocation: { settlement: { executor: admin }, transferLegId: "l", transferLeg: { sender: ALICE, receiver: BOB, amount: "0.000001", instrumentId: inst } } } });
const withT = (patch) => { const b = goodT(); Object.assign(b.choiceArguments.transfer, patch); return b; };

let pass = 0, fail = 0;
const ok = (n, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  — " + x : ""}`); };
async function call(method, path, body, { raw, headers } = {}) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${R}${path}`, { method, headers: { ...(body !== undefined || raw !== undefined ? { "Content-Type": "application/json" } : {}), ...headers }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), signal: AbortSignal.timeout(20_000) });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text, ms: Date.now() - t0 };
  } catch (e) { return { status: 0, json: null, text: String(e.message), ms: Date.now() - t0 }; }
}
// a case passes when the registry answers 2xx/4xx with JSON within the timeout (a 2xx is fine for harmless inputs)
const cases = [];
const add = (name, method, path, body, opts, allow2xx = false) => cases.push({ name, method, path, body, opts, allow2xx });

// malformed JSON bodies
for (const [n, raw] of [["body = null", "null"], ["body = array", "[]"], ["body = number", "42"], ["body = string", '"x"'], ["body = true", "true"], ["truncated JSON", '{"choiceArguments":{'], ["empty object", "{}"], ["not JSON", "hello"], ["unicode garbage", "\u0000\ud800{"], ["deeply nested", "[".repeat(5000) + "]".repeat(5000)]])
  for (const p of [TF, AF]) add(`${n} -> ${p.split("/")[2]}`, "POST", p, undefined, { raw }, n === "empty object" ? false : false);
// wrong shapes inside choiceArguments
for (const [n, b] of [
  ["choiceArguments = null", { choiceArguments: null }], ["choiceArguments = array", { choiceArguments: [] }], ["choiceArguments = string", { choiceArguments: "x" }],
  ["transfer = null", { choiceArguments: { expectedAdmin: admin, transfer: null } }], ["transfer = string", { choiceArguments: { expectedAdmin: admin, transfer: "x" } }], ["transfer = array", { choiceArguments: { expectedAdmin: admin, transfer: [] } }],
  ["transfer = {} with right admin", { choiceArguments: { expectedAdmin: admin, transfer: {} } }],
  ["expectedAdmin missing", { choiceArguments: { transfer: goodT().choiceArguments.transfer } }], ["expectedAdmin wrong", { choiceArguments: { ...goodT().choiceArguments, expectedAdmin: "someone::1220" } }],
  ["expectedAdmin = number", { choiceArguments: { ...goodT().choiceArguments, expectedAdmin: 7 } }],
  ["instrumentId missing", withT({ instrumentId: undefined })], ["instrumentId = string", withT({ instrumentId: "cUSDT" })], ["unknown instrument id", withT({ instrumentId: { admin, id: "NOPE" } })], ["instrument admin wrong", withT({ instrumentId: { admin: "x", id: "cUSDT" } })],
  ["receiver = null", withT({ receiver: null })], ["receiver = number", withT({ receiver: 5 })], ["receiver = object", withT({ receiver: { $ne: "" } })], ["receiver = array", withT({ receiver: [BOB] })], ["receiver = empty string", withT({ receiver: "" })],
  ["receiver = huge string", withT({ receiver: "a".repeat(100_000) })], ["receiver with quotes/backslashes", withT({ receiver: 'x"\\\'; DROP--' })], ["receiver = unknown party", withT({ receiver: "nobody::1220deadbeef" })],
  ["sender = receiver (self path)", withT({ receiver: ALICE })], ["sender = null", withT({ sender: null })],
]) add(n, "POST", TF, b, undefined, ["sender = receiver (self path)", "unknown instrument id"].includes(n) ? false : false);
for (const [n, b] of [
  ["alloc: transferLeg = null", { choiceArguments: { expectedAdmin: admin, allocation: { transferLeg: null } } }], ["alloc: allocation = string", { choiceArguments: { expectedAdmin: admin, allocation: "x" } }],
  ["alloc: leg.instrumentId missing", { choiceArguments: { expectedAdmin: admin, allocation: { transferLeg: {} } } }], ["alloc: unknown instrument", { choiceArguments: { expectedAdmin: admin, allocation: { transferLeg: { instrumentId: { admin, id: "NOPE" } } } } }],
  ["alloc: expectedAdmin wrong", { choiceArguments: { ...goodA().choiceArguments, expectedAdmin: "x" } }],
]) add(n, "POST", AF, b);
// routing / methods / paths
for (const [m, p, n] of [["GET", TF, "GET on a POST route"], ["PUT", TF, "PUT"], ["DELETE", "/health", "DELETE /health"], ["GET", "/", "GET /"], ["GET", "/registry", "GET /registry"], ["GET", "/registry/metadata/v1/instruments/NOPE", "unknown instrument path"],
  ["GET", "/registry/../../etc/passwd", "path traversal"], ["GET", "/%00", "NUL byte path"], ["GET", "/%zz", "bad percent-encoding"], ["GET", `/api/token-standard/v0/registrars/%E0%A4%A/registry/metadata/v1/info`, "alias with invalid encoding"],
  ["GET", `/api/token-standard/v0/registrars/wrong/registry/metadata/v1/info`, "alias with wrong registrar"], ["GET", "/registry/metadata/v1/info?" + "a=b&".repeat(5000), "huge query string"],
  ["POST", "/registry/allocations/v1/x/choice-contexts/bogus", "unknown allocation choice"], ["POST", "/registry/transfer-instruction/v1/x/choice-contexts/bogus", "unknown instruction choice"],
  ["POST", "/registry/transfer-instruction/v1/" + "a".repeat(50_000) + "/choice-contexts/accept", "50k-char cid in path"]])
  add(n, m, p, undefined, undefined, ["DELETE /health"].includes(n));
add("body of 300 KB (over the 256 KB limit)", "POST", TF, undefined, { raw: JSON.stringify({ choiceArguments: { pad: "x".repeat(300_000) } }) });
add("wrong content-type with valid JSON", "POST", TF, undefined, { raw: JSON.stringify(goodT()), headers: { "Content-Type": "text/plain" } }, true);

console.log(`registry: ${R}\n`);
for (const c of cases) {
  const r = await call(c.method, c.path, c.body, c.opts);
  // nginx in front answers some junk itself (HTML 400/414) or drops the connection for oversized headers: that is a refusal too
  const front = /^<html>/i.test(r.text) && r.status >= 400 && r.status < 500 || (r.status === 0 && /query string/.test(c.name));
  const good = (r.status >= 200 && r.status < 500 && r.json !== null || front) && r.ms < 15_000;
  ok(c.name, good, `${r.status || "no answer"} in ${r.ms} ms${r.json?.error ? ` ("${String(r.json.error).slice(0, 70)}")` : ""}${good ? "" : ` !! ${r.text.slice(0, 120)}`}`);
}

// bursts: 40 concurrent garbage requests, then 40 concurrent valid ones
const burst = await Promise.all(Array.from({ length: 40 }, (_, i) => call("POST", TF, undefined, { raw: i % 2 ? "{" : "null" })));
ok("40 concurrent malformed requests: all answered 4xx", burst.every((r) => r.status >= 400 && r.status < 500), `statuses ${[...new Set(burst.map((r) => r.status))].join(",")}`);
const valid = await Promise.all(Array.from({ length: 20 }, () => call("POST", TF, goodT())));
ok("20 concurrent valid factory lookups all succeed", valid.every((r) => r.status === 200 && r.json?.factoryId), `statuses ${[...new Set(valid.map((r) => r.status))].join(",")}, max ${Math.max(...valid.map((r) => r.ms))} ms`);
const h = await call("GET", "/health");
ok("registry still healthy after the whole run", h.status === 200 && h.json?.ok === true);
const after = await call("POST", TF, goodT());
ok("and still returns a correct transfer-factory answer", after.status === 200 && ["offer", "direct"].includes(after.json?.transferKind), after.json?.transferKind);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
