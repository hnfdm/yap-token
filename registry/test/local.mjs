// Local test of the registry against a MOCK ledger + Keycloak (no network, no traffic):  node registry/test/local.mjs
// Covers the V1 and V2 transfer-factory answers (offer / direct / self), V2 request validation and the V2 choice contexts.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ADMIN = "cusdt-admin::1220aaaa", ALICE = "alice::1220aaaa", BOB = "bob::1220aaaa", CAROL = "carol::1220aaaa";
const ctr = (tpl, id, arg = {}) => ({ contractEntry: { JsActiveContract: { synchronizerId: "sync::1", createdEvent: { contractId: id, createdEventBlob: "blob-" + id, templateId: `pkg:CusdtToken:${tpl}`, createArgument: arg } } } });

const mock = createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    const j = (o) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url.includes("openid-connect/token")) return j({ access_token: "t", expires_in: 300 });
    if (req.url.endsWith("/v2/state/ledger-end")) return j({ offset: 1 });
    if (req.url.endsWith("/v2/state/active-contracts")) {
      const body = JSON.parse(b || "{}");
      const tpl = body.eventFormat?.filtersByParty?.[ADMIN]?.cumulative?.[0]?.identifierFilter?.TemplateFilter?.value?.templateId ?? "";
      if (tpl.endsWith("CusdtTransferFactory")) return j([ctr("CusdtTransferFactory", "factory-1")]);
      if (tpl.endsWith("CusdtAllocationFactory")) return j([ctr("CusdtAllocationFactory", "afactory-1")]);
      if (tpl.endsWith("CusdtTransferPreapproval")) return j([ctr("CusdtTransferPreapproval", "pre-bob", { admin: ADMIN, receiver: BOB })]);
      return j([]);
    }
    res.writeHead(404); res.end("{}");
  });
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const mport = mock.address().port, RPORT = 18787;
const child = spawn(process.execPath, [join(here, "..", "src", "server.mjs")], { env: { ...process.env, HOST: "127.0.0.1", PORT: String(RPORT),
  LEDGER_URL: `http://127.0.0.1:${mport}`, KC_TOKEN_URL: `http://127.0.0.1:${mport}/openid-connect/token`, KC_CLIENT_ID: "c", KC_CLIENT_SECRET: "s",
  CUSDT_ADMIN_PARTY: ADMIN, CUSDT_ENABLE_V2: process.env.CUSDT_ENABLE_V2 ?? "1" }, stdio: ["ignore", "ignore", "inherit"] });
await new Promise((r) => setTimeout(r, 900));

let pass = 0, fail = 0;
const ok = (n, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  — " + x : ""}`); };
const call = async (method, path, body) => { const r = await fetch(`http://127.0.0.1:${RPORT}${path}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); let j = null; try { j = await r.json(); } catch { /* empty */ } return { status: r.status, j }; };
const inst = { admin: ADMIN, id: "YAP" };
const t1 = (s, r, extra = {}) => ({ choiceArguments: { expectedAdmin: ADMIN, transfer: { sender: s, receiver: r, amount: "1", instrumentId: inst, ...extra } } });
const acct = (owner, extra = {}) => ({ owner, provider: null, id: "", ...extra });
const t2 = (s, r, extra = {}) => ({ choiceArguments: { transfer: { sender: s, receiver: r, amount: "1", instrumentId: inst, ...extra } } });
const F1 = "/registry/transfer-instruction/v1/transfer-factory", F2 = "/registry/transfer-instruction/v2/transfer-factory";

try {
  // V1 (unchanged behaviour after the refactor)
  let r = await call("POST", F1, t1(ALICE, CAROL)); ok("V1 offer", r.status === 200 && r.j.transferKind === "offer" && r.j.factoryId === "factory-1");
  r = await call("POST", F1, t1(ALICE, BOB)); ok("V1 direct (receiver has a preapproval), preapproval disclosed", r.j.transferKind === "direct" && r.j.choiceContext.disclosedContracts.length === 2 && r.j.choiceContext.choiceContextData.values["cusdt.mahawallet.xyz/transfer-preapproval"].value === "pre-bob");
  r = await call("POST", F1, t1(ALICE, ALICE)); ok("V1 self", r.j.transferKind === "self");
  r = await call("POST", F1, t1(ALICE, null)); ok("V1 receiver null -> 400", r.status === 400);
  r = await call("POST", F1, { choiceArguments: { expectedAdmin: "x", transfer: {} } }); ok("V1 wrong expectedAdmin -> 400", r.status === 400);
  // V2
  r = await call("POST", F2, t2(acct(ALICE), acct(CAROL))); ok("V2 offer", r.status === 200 && r.j.transferKind === "offer" && r.j.factoryId === "factory-1");
  r = await call("POST", F2, t2(acct(ALICE), acct(BOB))); ok("V2 direct", r.j.transferKind === "direct" && r.j.choiceContext.disclosedContracts.length === 2);
  r = await call("POST", F2, t2(acct(ALICE), acct(ALICE))); ok("V2 self", r.j.transferKind === "self");
  r = await call("POST", F2, t2(acct(ALICE), acct(CAROL), { instrumentId: { admin: ADMIN, id: "NOPE" } })); ok("V2 unknown instrument -> 404", r.status === 404);
  r = await call("POST", F2, t2(acct(ALICE), acct(CAROL), { instrumentId: { admin: "other", id: "YAP" } })); ok("V2 other admin's instrument -> 404", r.status === 404);
  r = await call("POST", F2, t2(ALICE, acct(CAROL))); ok("V2 sender as a plain string (V1 shape) -> 400", r.status === 400);
  r = await call("POST", F2, t2(acct(ALICE), acct(CAROL, { provider: ADMIN }))); ok("V2 account with a provider -> 400", r.status === 400);
  r = await call("POST", F2, t2(acct(ALICE), acct(CAROL, { id: "savings" }))); ok("V2 non-default account id -> 400", r.status === 400);
  r = await call("POST", F2, t2(acct(ALICE), { owner: null, provider: null, id: "" })); ok("V2 admin-managed account (owner null) -> 400", r.status === 400);
  r = await call("POST", F2, t2(acct(ALICE), null)); ok("V2 receiver null -> 400", r.status === 400);
  r = await call("POST", F2, t2(acct(ALICE), [])); ok("V2 receiver array -> 400", r.status === 400);
  r = await call("POST", F2, { choiceArguments: {} }); ok("V2 no transfer -> 400", r.status === 400);
  r = await call("POST", F2, { choiceArguments: { transfer: "x" } }); ok("V2 transfer a string -> 400", r.status === 400);
  r = await call("POST", F2, null); ok("V2 body null -> 400", r.status === 400);
  for (const a of ["accept", "reject", "withdraw"]) { r = await call("POST", `/registry/transfer-instruction/v2/cid123/choice-contexts/${a}`, {}); ok(`V2 choice-context ${a}`, r.status === 200 && r.j.disclosedContracts.length === 0); }
  r = await call("POST", "/registry/transfer-instruction/v2/cid123/choice-contexts/bogus", {}); ok("V2 unknown choice -> 404", r.status === 404);
  r = await call("POST", `/api/token-standard/v0/registrars/${encodeURIComponent(ADMIN)}${F2}`, t2(acct(ALICE), acct(CAROL))); ok("V2 through the Utility-style alias path", r.status === 200 && r.j.transferKind === "offer");
  r = await call("GET", "/registry/metadata/v1/info"); ok("V2 advertised when CUSDT_ENABLE_V2=1", r.j.supportedApis["splice-api-token-transfer-instruction-v2"] === 1 && r.j.supportedApis["splice-api-token-holding-v2"] === 1);
} finally { child.kill(); mock.close(); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
