// How does the registry behave when things go wrong? (the deployed one at CUSDT_REGISTRY_URL, plus a throw-away local instance)
//   A  HTTP hygiene      B  burst of concurrent requests     C  hanging connections
//   D  stale factory after a rotation (a wallet holding an old factory id)
//   E  broken backends: ledger unreachable / wrong Keycloak secret (local instance, VPS untouched)
// Only D changes state: it runs scripts/8-rotate-singletons.mjs (the normal release step) and moves 1 micro back and forth.
import { spawn, execFileSync } from "node:child_process";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { getToken, submit, need, env } from "./lib.mjs";
import { snapshot, supply, checkInvariants, retry } from "./invariants.mjs";
import { makeOps, amt, iso, IF } from "./ops.mjs";

const admin = need("CUSDT_ADMIN_PARTY");
const suffix = admin.split("::")[1];
const ALICE = `cusdt-alice::${suffix}`, BOB = `cusdt-bob::${suffix}`;
const REG = process.env.CUSDT_REGISTRY_URL || "https://registry-testnet.cryptolampung.space";
const token = await getToken();
const { transfer, ti, tpl } = makeOps({ token, admin, registry: REG });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inst = { admin, id: "cUSDT" };

let pass = 0, fail = 0;
const ok = (n, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  — " + x : ""}`); };
async function http(method, path, { body, base = REG, raw, headers = {} } = {}) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${base}${path}`, { method, headers: { ...(body !== undefined || raw ? { "Content-Type": "application/json" } : {}), ...headers }, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined), signal: AbortSignal.timeout(30_000) });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text, ms: Date.now() - t0, headers: r.headers };
  } catch (e) { return { status: 0, json: null, text: String(e.cause?.code ?? e.message), ms: Date.now() - t0, headers: new Headers() }; }
}
const goodTransfer = { sender: ALICE, receiver: BOB, amount: "0.0000010000", instrumentId: inst, requestedAt: iso(-30_000), executeBefore: iso(3_600_000), inputHoldingCids: [], meta: { values: {} } };
const FACTORY = "/registry/transfer-instruction/v1/transfer-factory";
const factoryBody = (patch = {}) => ({ choiceArguments: { expectedAdmin: admin, transfer: { ...goodTransfer, ...patch } } });

// ---- A. HTTP hygiene ------------------------------------------------------------------------------
console.log("-- A. HTTP hygiene");
let r = await http("POST", FACTORY, { raw: "{ this is not json" });                                ok("invalid JSON -> 400 with a JSON error", r.status === 400 && !!r.json?.error, `${r.status} ${r.text.slice(0, 60)}`);
r = await http("POST", FACTORY, { body: {} });                                                      ok("missing choiceArguments -> 400", r.status === 400, `${r.status} ${r.json?.error ?? r.text.slice(0, 50)}`);
r = await http("POST", FACTORY, { body: { choiceArguments: { expectedAdmin: admin } } });           ok("missing transfer -> 400", r.status === 400, `${r.status}`);
r = await http("POST", FACTORY, { body: { choiceArguments: { expectedAdmin: BOB, transfer: goodTransfer } } }); ok("wrong expectedAdmin -> 400", r.status === 400, `${r.status} ${r.json?.error ?? ""}`);
r = await http("POST", FACTORY, { body: factoryBody({ instrumentId: { admin, id: "NOPE" } }) });   ok("unknown instrument -> 404", r.status === 404, `${r.status}`);
r = await http("POST", "/registry/allocation-instruction/v1/allocation-factory", { body: { choiceArguments: { expectedAdmin: admin, allocation: {} } } }); ok("allocation without transferLeg -> 400", r.status === 400, `${r.status}`);
r = await http("POST", FACTORY, { raw: JSON.stringify({ pad: "x".repeat(300_000) }) });             ok("300 KB body is refused (413) or the connection is cut, never served", r.status === 413 || r.status === 0, `${r.status} ${r.status === 0 ? r.text : ""}`);
r = await http("GET", FACTORY);                                                                     ok("GET on a POST route -> 404", r.status === 404, `${r.status}`);
r = await http("GET", "/nope");                                                                     ok("unknown path -> 404 JSON", r.status === 404 && !!r.json?.error, `${r.status}`);
r = await http("GET", "/registry/%2e%2e/%2e%2e/etc/passwd");                                        ok("encoded path traversal -> 4xx, no file content", r.status >= 400 && r.status < 500 && !/root:/.test(r.text), `${r.status}`);
r = await http("GET", "/registry/" + "a".repeat(10_000));                                           ok("10 KB URL -> 4xx, no crash", r.status >= 400 && r.status < 500, `${r.status}`);
r = await http("OPTIONS", FACTORY);                                                                 ok("CORS preflight -> 204", r.status === 204 && r.headers.get("access-control-allow-origin") === "*", `${r.status}`);
r = await http("GET", "/registry/metadata/v1/info");                                                ok("service still healthy after all that", r.status === 200 && r.json?.adminId === admin, `${r.status} in ${r.ms} ms`);
console.log(`      server header: ${r.headers.get("server") ?? "(none)"}  x-powered-by: ${r.headers.get("x-powered-by") ?? "(none)"}`);

// ---- B. burst -----------------------------------------------------------------------------------------
console.log("-- B. burst");
{ const N = 40; const t0 = Date.now();
  const rs = await Promise.all(Array.from({ length: N }, () => http("POST", FACTORY, { body: factoryBody() })));
  const okN = rs.filter((x) => x.status === 200 && x.json?.factoryId).length;
  const ms = rs.map((x) => x.ms).sort((a, b) => a - b);
  ok(`${N} simultaneous transfer-factory requests all answered correctly`, okN === N, `${okN}/${N} ok in ${Date.now() - t0} ms; latency p50 ${ms[Math.floor(N / 2)]} ms, p95 ${ms[Math.floor(N * 0.95)]} ms, max ${ms[N - 1]} ms; statuses ${[...new Set(rs.map((x) => x.status))].join(",")}`);
  const info = await Promise.all(Array.from({ length: 100 }, () => http("GET", "/registry/metadata/v1/info")));
  ok("100 simultaneous metadata requests", info.every((x) => x.status === 200), `max ${Math.max(...info.map((x) => x.ms))} ms`); }

// ---- C. hanging connections -----------------------------------------------------------------------------
console.log("-- C. hanging connections");
{ const u = new URL(REG); const socks = [];
  await Promise.all(Array.from({ length: 20 }, () => new Promise((res) => {
    const s = tls.connect({ host: u.hostname, port: 443, servername: u.hostname, rejectUnauthorized: false }, () => { s.write(`POST ${FACTORY} HTTP/1.1\r\nHost: ${u.hostname}\r\nContent-Type: application/json\r\nContent-Length: 5000\r\n\r\n{"x":`); res(); });
    s.on("error", () => res()); socks.push(s);
  })));
  const h = await http("GET", "/registry/metadata/v1/info");
  ok("20 half-sent requests do not block normal traffic", h.status === 200 && h.ms < 5000, `${h.status} in ${h.ms} ms`);
  socks.forEach((s) => s.destroy()); await sleep(500); }

// ---- D. stale factory after a rotation --------------------------------------------------------------------
console.log("-- D. stale factory after a rotation");
{ const S0 = await snapshot(token, admin); const expected = supply(S0);
  const holding = S0.H.filter((h) => h.createArgument.owner === ALICE && h.createArgument.lock == null).sort((a, b) => Number(b.createArgument.amount) - Number(a.createArgument.amount))[0];
  const t = { ...goodTransfer, inputHoldingCids: [holding.contractId] };
  const old = (await http("POST", FACTORY, { body: { choiceArguments: { expectedAdmin: admin, transfer: t } } })).json;   // what a wallet would be holding
  console.log("      rotating singletons (the normal release step) ...");
  execFileSync(process.execPath, [fileURLToPath(new URL("./8-rotate-singletons.mjs", import.meta.url))], { stdio: "ignore", env: process.env });
  let msg = "";
  try { await submit(token, { actAs: [ALICE], label: "stale", disclosedContracts: old.choiceContext.disclosedContracts,
      commands: [{ ExerciseCommand: { templateId: IF.TF, contractId: old.factoryId, choice: "TransferFactory_Transfer", choiceArgument: { expectedAdmin: admin, transfer: t, extraArgs: { context: old.choiceContext.choiceContextData, meta: { values: {} } } } } }] }); }
  catch (e) { msg = String(e.message).replace(/\s+/g, " "); }
  ok("a wallet using the OLD factory id fails cleanly", msg !== "", msg ? msg.match(/CONTRACT_NOT_FOUND|LOCAL_VERDICT_[A-Z_]+|INACTIVE[A-Z_]*|ABORTED/)?.[0] ?? msg.slice(-90) : "unexpectedly succeeded");
  let healedAfter = null; const t0 = Date.now();
  while (Date.now() - t0 < 60_000) { const cur = (await http("POST", FACTORY, { body: { choiceArguments: { expectedAdmin: admin, transfer: t } } })).json; if (cur?.factoryId && cur.factoryId !== old.factoryId) { healedAfter = Math.round((Date.now() - t0) / 1000); break; } await sleep(3000); }
  ok("the registry hands out the NEW factory (cache is 30 s)", healedAfter !== null, healedAfter === null ? "still stale after 60 s" : `healed ${healedAfter} s after the rotation finished`);
  let done = true; try { await transfer(ALICE, BOB, amt(1), [holding])(); } catch (e) { done = false; console.log("      " + String(e.message).slice(-120)); }
  ok("after healing, a normal transfer works again", done);
  const Sx = await snapshot(token, admin);
  for (const i of Sx.I) await ti(i.createArgument.transfer.sender, i.contractId, "TransferInstruction_Withdraw")().catch(() => {});
  const v = checkInvariants(await snapshot(token, admin), expected); ok("conservation holds after the rotation test", v.length === 0, v.join("; ")); }

// ---- E. broken backends (local instance) ---------------------------------------------------------------------
console.log("-- E. broken backends (local instance on :8799)");
async function withLocal(extraEnv, fn) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../registry/src/server.mjs", import.meta.url))],
    { env: { ...process.env, PORT: "8799", HOST: "127.0.0.1", CUSDT_ADMIN_PARTY: admin, NODE_TLS_REJECT_UNAUTHORIZED: "0", ...extraEnv }, stdio: "ignore" });
  const base = "http://127.0.0.1:8799";
  try { for (let i = 0; i < 20; i++) { if ((await http("GET", "/health", { base })).status === 200) break; await sleep(250); } await fn(base); }
  finally { child.kill(); await sleep(300); }
}
const goodEnv = { LEDGER_URL: need("LEDGER_URL"), KC_TOKEN_URL: need("KC_TOKEN_URL"), KC_CLIENT_ID: env.KC_CLIENT_ID, KC_CLIENT_SECRET: env.KC_CLIENT_SECRET };
await withLocal({ ...goodEnv, LEDGER_URL: "http://127.0.0.1:9" }, async (base) => {
  const f = await http("POST", FACTORY, { body: factoryBody(), base });
  ok("ledger unreachable: factory request -> 500 JSON error, no hang", f.status === 500 && !!f.json?.error && f.ms < 20_000, `${f.status} in ${f.ms} ms`);
  const m = await http("GET", "/registry/metadata/v1/info", { base });
  ok("ledger unreachable: metadata endpoints still work", m.status === 200 && m.json?.adminId === admin);
  ok("ledger unreachable: process is still alive", (await http("GET", "/health", { base })).status === 200);
});
await withLocal({ ...goodEnv, KC_CLIENT_SECRET: "definitely-wrong" }, async (base) => {
  const f = await http("POST", FACTORY, { body: factoryBody(), base });
  ok("wrong Keycloak secret: -> 500 JSON error that does not leak the secret", f.status === 500 && !!f.json?.error && !/definitely-wrong/.test(f.text), `${f.status} ${f.json?.error ?? f.text.slice(0, 60)}`);
  ok("wrong Keycloak secret: process is still alive", (await http("GET", "/health", { base })).status === 200);
});
await withLocal({ ...goodEnv }, async (base) => {                      // control: the same instance with good settings works
  const f = await http("POST", FACTORY, { body: factoryBody(), base });
  ok("control: local instance with correct settings works", f.status === 200 && !!f.json?.factoryId, `${f.status}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
