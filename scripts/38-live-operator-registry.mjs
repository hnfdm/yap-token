// LIVE test of cusdt-token 0.7.0: tokens minted by the OPERATOR (not the admin) behave like any other holding in the
// registry flows: V1 offer + accept, V2 offer + accept, and a DIRECT transfer to the operator (it created its own preapproval).
//   node scripts/38-live-operator-registry.mjs      (.env.testnet = t1, needs CUSDT_OPERATOR)
// Starts the registry code locally (port 18789, V2 on) against the real ledger. Everything is burnt at the end.
import { spawn } from "node:child_process";
import { loadEnv } from "./lib.mjs";
import { snapshot, supply, checkInvariants } from "./invariants.mjs";
import { node, waitFor, sleep } from "./nodes.mjs";

const E = loadEnv(".env.testnet"); if (E.INSECURE_TLS === "1") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
if (!E.CUSDT_OPERATOR) throw new Error("CUSDT_OPERATOR missing in .env.testnet");
const n = node(E, "t1"), admin = E.CUSDT_ADMIN_PARTY, ALICE = E.CUSDT_ALICE, BOB = E.CUSDT_BOB, OP = E.CUSDT_OPERATOR;
const P = "#cusdt-token:CusdtToken:", HOLD = P + "CusdtHolding", ADM = P + "CusdtAdmin", OPA = P + "CusdtOperatorAuthority", PRE = P + "CusdtTransferPreapproval", BMF = P + "CusdtBurnMintFactory";
const I_BM = "#splice-api-token-burn-mint-v1:Splice.Api.Token.BurnMintV1:BurnMintFactory";
const I_TF1 = "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory";
const I_TI1 = "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction";
const I_TF2 = "#splice-api-token-transfer-instruction-v2:Splice.Api.Token.TransferInstructionV2:TransferFactory";
const I_TI2 = "#splice-api-token-transfer-instruction-v2:Splice.Api.Token.TransferInstructionV2:TransferInstruction";
const inst = { admin, id: "YAP" }, noCtx = { context: { values: {} }, meta: { values: {} } };
const short = (e) => String(e?.message ?? e).replace(/\s+/g, " ");
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const mu = (c) => Math.round(Number(c.createArgument.amount) * 1e6);
const amt = (m) => (m / 1e6).toFixed(10);
const acct = (p) => ({ owner: p, provider: null, id: "" });
let pass = 0, fail = 0;
const ok = (m, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}  ${m}${x ? "  — " + x : ""}`); };
const ex = (templateId, contractId, choice, choiceArgument = {}) => ({ ExerciseCommand: { templateId, contractId, choice, choiceArgument } });
const all = async (p) => (await n.acs(p, HOLD)).filter((c) => c.createArgument.owner === p);
const free = async (p) => (await all(p)).filter((c) => c.createArgument.lock == null);
const total = async (p) => (await free(p)).reduce((s, c) => s + mu(c), 0);
async function group(name, fn) { console.log(`-- ${name}`); try { await fn(); } catch (e) { fail++; console.log(`FAIL  ${name} threw: ${short(e).slice(0, 400)}`); } }

const S0 = await snapshot(await n.token(), admin), expected = supply(S0);
const known = new Set([...(await all(ALICE)), ...(await all(BOB)), ...(await all(OP)), ...(await all(admin))].map((c) => c.contractId));
console.log(`start: supply ${expected / 1e6}`);
const books = async (label, extra = 0) => { const v = checkInvariants(await snapshot(await n.token(), admin), expected + extra); ok(`conservation after ${label}`, v.length === 0, v.join("; ")); };

const RP = 18789;
const reg = spawn(process.execPath, ["registry/src/server.mjs"], { env: { ...process.env, HOST: "127.0.0.1", PORT: String(RP), LEDGER_URL: E.LEDGER_URL, KC_TOKEN_URL: E.KC_TOKEN_URL, KC_CLIENT_ID: E.KC_CLIENT_ID, KC_CLIENT_SECRET: E.KC_CLIENT_SECRET, KC_SCOPE: E.KC_SCOPE ?? "daml_ledger_api", CUSDT_ADMIN_PARTY: admin, CUSDT_ENABLE_V2: "1", NODE_TLS_REJECT_UNAUTHORIZED: "0" }, stdio: ["ignore", "ignore", "inherit"] });
await sleep(1200);
const rpost = (path, body) => fetch(`http://127.0.0.1:${RP}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, j: await r.json().catch(() => null) }));
const authority = async () => (await n.acs(admin, OPA))[0];
const mintByOperator = async (to, micro) => {
  const a = await authority();
  const before = new Set((await free(to)).map((c) => c.contractId));
  await n.tx([OP], [ex(OPA, a.contractId, "CusdtOperator_Mint", { recipient: to, amount: amt(micro) })]);
  return (await waitFor(async () => (await free(to)).find((c) => !before.has(c.contractId) && mu(c) === micro))).v;
};
let minted = 0;

try {
  const [adm] = await n.acs(admin, ADM), [bf] = await n.acs(admin, BMF);
  for (const a of await n.acs(admin, OPA)) await n.tx([admin], [ex(OPA, a.contractId, "Archive")]);
  for (const p of (await n.acs(admin, PRE)).filter((p) => p.createArgument.receiver === OP)) await n.tx([admin], [ex(PRE, p.contractId, "Archive")]); // OP starts without a preapproval, so V1/V2 go through offers
const oldPre = new Set();
  await n.tx([admin], [ex(ADM, adm.contractId, "CusdtAdmin_AppointOperator", { operator: OP, allowance: amt(100000), validUntil: iso(3_600_000) })]);
  await waitFor(async () => (await authority()) || null);

  await group("V1 flow with an operator-minted holding: registry offer, operator accepts", async () => {
    const h = await mintByOperator(ALICE, 7000); minted += 7000;
    ok("operator minted a 7000-micro holding for alice", !!h);
    const b0 = await total(OP);
    const t = { sender: ALICE, receiver: OP, amount: amt(7000), instrumentId: inst, requestedAt: iso(-30000), executeBefore: iso(3_600_000), inputHoldingCids: [h.contractId], meta: { values: {} } };
    const f = await rpost("/registry/transfer-instruction/v1/transfer-factory", { choiceArguments: { expectedAdmin: admin, transfer: t } });
    ok("registry V1 answered `offer`", f.status === 200 && f.j.transferKind === "offer", `${f.status} ${f.j?.transferKind}`);
    await n.tx([ALICE], [ex(I_TF1, f.j.factoryId, "TransferFactory_Transfer", { expectedAdmin: admin, transfer: t, extraArgs: { context: f.j.choiceContext.choiceContextData, meta: { values: {} } } })], f.j.choiceContext.disclosedContracts);
    if (f.j.transferKind === "offer") {
      const p = (await waitFor(async () => (await n.acs(admin, P + "CusdtTransferInstruction")).find((i) => i.createArgument.transfer.receiver === OP && mu({ createArgument: { amount: i.createArgument.transfer.amount } }) === 7000))).v;
      await n.tx([OP], [ex(I_TI1, p.contractId, "TransferInstruction_Accept", { extraArgs: noCtx })]);
    }
    await sleep(1500);
    ok("the operator received exactly 7000 micro", (await total(OP)) === b0 + 7000);
    await books("V1 transfer of operator-minted tokens", minted);
  });

  await group("V2 flow with an operator-minted holding: registry offer, operator accepts", async () => {
    const h = await mintByOperator(ALICE, 6000); minted += 6000;
    const b0 = await total(OP);
    const t = { sender: acct(ALICE), receiver: acct(OP), amount: amt(6000), instrumentId: inst, requestedAt: iso(-30000), executeBefore: iso(3_600_000), inputHoldingCids: [h.contractId], meta: { values: {} } };
    const f = await rpost("/registry/transfer-instruction/v2/transfer-factory", { choiceArguments: { transfer: t } });
    ok("registry V2 answered `offer`", f.status === 200 && f.j.transferKind === "offer", `${f.status} ${f.j?.transferKind}`);
    await n.tx([ALICE], [ex(I_TF2, f.j.factoryId, "TransferFactory_Transfer", { transfer: t, actors: [ALICE], extraArgs: { context: f.j.choiceContext.choiceContextData, meta: { values: {} } } })], f.j.choiceContext.disclosedContracts);
    if (f.j.transferKind === "offer") {
      const p = (await waitFor(async () => (await n.acs(admin, P + "CusdtTransferInstruction")).find((i) => i.createArgument.transfer.receiver === OP && Math.round(Number(i.createArgument.transfer.amount) * 1e6) === 6000))).v;
      await n.tx([OP], [ex(I_TI2, p.contractId, "TransferInstruction_Accept", { actors: [OP], extraArgs: noCtx })]);
    }
    await sleep(1500);
    ok("the operator received exactly 6000 micro through V2", (await total(OP)) === b0 + 6000);
    await books("V2 transfer of operator-minted tokens", minted);
  });

  await group("DIRECT transfer to the operator (preapproval created by the operator itself)", async () => {
    const a = await authority();
    await n.tx([OP], [ex(OPA, a.contractId, "CusdtOperator_CreatePreapproval", { receiver: OP })]);
    const h = await mintByOperator(ALICE, 5000); minted += 5000;
    const o0 = await total(OP);
    const t = { sender: acct(ALICE), receiver: acct(OP), amount: amt(5000), instrumentId: inst, requestedAt: iso(-30000), executeBefore: iso(3_600_000), inputHoldingCids: [h.contractId], meta: { values: {} } };
    const f = await rpost("/registry/transfer-instruction/v2/transfer-factory", { choiceArguments: { transfer: t } });
    ok("registry says `direct` (the operator's preapproval is found)", f.j?.transferKind === "direct", `${f.status} ${f.j?.transferKind}`);
    await n.tx([ALICE], [ex(I_TF2, f.j.factoryId, "TransferFactory_Transfer", { transfer: t, actors: [ALICE], extraArgs: { context: f.j.choiceContext.choiceContextData, meta: { values: {} } } })], f.j.choiceContext.disclosedContracts);
    await sleep(1500);
    ok("the operator received 5000 micro at once", (await total(OP)) === o0 + 5000);
    await books("direct transfer to the operator", minted);
  });

  await group("clean up: burn what the test created, remove the operator and its preapproval", async () => {
    for (const p of [ALICE, BOB, OP, admin]) {
      const mine = (await free(p)).filter((c) => !known.has(c.contractId));
      if (!mine.length) continue;
      await n.tx([admin, p].filter((x, i, a) => a.indexOf(x) === i), [ex(I_BM, bf.contractId, "BurnMintFactory_BurnMint", { expectedAdmin: admin, instrumentId: inst, inputHoldingCids: mine.map((c) => c.contractId), outputs: [], extraActors: [p], extraArgs: noCtx })]);
    }
    for (const a of await n.acs(admin, OPA)) await n.tx([admin], [ex(OPA, a.contractId, "Archive")]);
    for (const p of (await n.acs(admin, PRE)).filter((p) => p.createArgument.receiver === OP && !oldPre.has(p.contractId))) await n.tx([admin], [ex(PRE, p.contractId, "Archive")]);
    const left = [...(await all(ALICE)), ...(await all(BOB)), ...(await all(OP)), ...(await all(admin))].filter((c) => !known.has(c.contractId));
    ok("no holding created by this test is left", left.length === 0, left.map(mu).join(","));
    const sup = supply(await snapshot(await n.token(), admin));
    ok("supply is back to the start", sup === expected, `${sup - expected} micro off (minted ${minted})`);
  });
} finally { reg.kill(); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
