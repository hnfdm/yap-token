// LIVE test of Token Standard V2 allocations on the YAP instance (admin = the decentralized party; NO governance vote is needed:
// allocating is done by the holders, settling by the executor, and the factories carry the admin's authority).
//   node scripts/44-live-allocation-v2.mjs        (.env.testnet = t1; ~1 minute, no human steps)
// alice and bob exchange YAP in two legs (alice pays 10, bob pays 3 -> alice's NET outflow is 7); the executor is cusdt-operator.
// Then the guards: mismatched legs, direct settle, committed allocations. The supply must be exactly the same at the end.
import { spawn } from "node:child_process";
import { loadEnv } from "./lib.mjs";
import { node, waitFor, sleep } from "./nodes.mjs";

const E = loadEnv(".env.testnet"); if (E.INSECURE_TLS === "1") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const n = node(E, "t1");
const GOV = E.CUSDT_GOV_PARTY ?? "cusdt-gov::12205fb8f032bfcfe6ae4ae3a7625629fe9065668ee529e3a785691e1cdce5022c2b";
const ALICE = E.CUSDT_ALICE, BOB = E.CUSDT_BOB, EXEC = E.CUSDT_OPERATOR;
const P = "#yap-token:YapToken:";
const HOLD = P + "YapHolding", ALLOC2 = P + "YapAllocationV2", INSTR = P + "YapTransferInstruction";
const I_AF2 = "#splice-api-token-allocation-instruction-v2:Splice.Api.Token.AllocationInstructionV2:AllocationFactory";
const I_SF2 = "#splice-api-token-allocation-v2:Splice.Api.Token.AllocationV2:SettlementFactory";
const I_AL2 = "#splice-api-token-allocation-v2:Splice.Api.Token.AllocationV2:Allocation";
const short = (e) => String(e?.message ?? e).replace(/\s+/g, " ");
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const mu = (c) => Math.round(Number(c.createArgument.amount) * 1e6);
const amt = (m) => (m / 1e6).toFixed(10);
const acct = (p) => ({ owner: p, provider: null, id: "" });
const noExtra = { context: { values: {} }, meta: { values: {} } };
let pass = 0, fail = 0;
const ok = (m, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}  ${m}${x ? "  — " + x : ""}`); };
const ex = (templateId, contractId, choice, choiceArgument = {}) => ({ ExerciseCommand: { templateId, contractId, choice, choiceArgument } });
const refused = async (fn) => { try { await fn(); return { refused: false, msg: "ACCEPTED" }; } catch (e) { return { refused: true, msg: short(e) }; } };
const holdings = async () => n.acs(GOV, HOLD);
const free = async (p) => (await holdings()).filter((c) => c.createArgument.owner === p && c.createArgument.lock == null);
const total = async (p) => (await free(p)).reduce((s, c) => s + mu(c), 0);
const lockedSum = async (p) => (await holdings()).filter((c) => c.createArgument.owner === p && c.createArgument.lock != null).reduce((s, c) => s + mu(c), 0);
const supplyNow = async () => (await holdings()).reduce((s, c) => s + mu(c), 0) + (await n.acs(GOV, INSTR)).reduce((s, i) => s + Math.round(Number(i.createArgument.transfer.amount) * 1e6), 0);
const resultOf = (r, choice) => r.transaction.events.find((e) => e.ExercisedEvent?.choice === choice)?.ExercisedEvent?.exerciseResult;
async function group(name, fn) { console.log(`-- ${name}`); try { await fn(); } catch (e) { fail++; console.log(`FAIL  ${name} threw: ${short(e).slice(0, 600)}`); } }

if (!EXEC) throw new Error("CUSDT_OPERATOR missing in .env.testnet");
const RP = 18792;
const reg = spawn(process.execPath, ["registry/src/server.mjs"], { env: { ...process.env, HOST: "127.0.0.1", PORT: String(RP), LEDGER_URL: E.LEDGER_URL, KC_TOKEN_URL: E.KC_TOKEN_URL, KC_CLIENT_ID: E.KC_CLIENT_ID, KC_CLIENT_SECRET: E.KC_CLIENT_SECRET, KC_SCOPE: E.KC_SCOPE ?? "daml_ledger_api", CUSDT_ADMIN_PARTY: GOV, CUSDT_ENABLE_V2: "1", CUSDT_ENABLE_ALLOCATION_V2: "1", NODE_TLS_REJECT_UNAUTHORIZED: "0" }, stdio: ["ignore", "ignore", "inherit"] });
await sleep(1500);
const rpost = (path, body) => fetch(`http://127.0.0.1:${RP}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, j: await r.json().catch(() => null) }));

const sid = `live-${Date.now()}`;
const settlement = { executors: [EXEC], id: sid, cid: null, meta: { values: {} } };
const side = (lid, s, other, y) => ({ transferLegId: lid, side: s, otherside: acct(other), amount: amt(y * 1e6), instrumentId: "YAP", meta: { values: {} } });
const leg = (lid, from, to, y) => ({ transferLegId: lid, sender: acct(from), receiver: acct(to), amount: amt(y * 1e6), instrumentId: "YAP", meta: { values: {} } });
const spec = (owner, sides, deadlineMs, committed) => ({ admin: GOV, authorizer: acct(owner), transferLegSides: sides, settlementDeadline: iso(deadlineMs), nextIterationFunding: null, committed, meta: { values: {} } });

// ask the registry for the factory, then let the holder allocate (input = the biggest free holding unless none is needed)
async function allocate(owner, settl, specification, inputs) {
  const body = { choiceArguments: { settlement: settl, allocation: specification, requestedAt: iso(-30000), inputHoldingCids: inputs, extraArgs: noExtra, actors: [owner] } };
  const f = await rpost("/registry/allocation-instruction/v2/allocation-factory", body);
  if (f.status !== 200) throw new Error(`registry allocation-factory ${f.status} ${JSON.stringify(f.j)}`);
  const r = await n.tx([owner], [ex(I_AF2, f.j.factoryId, "AllocationFactory_Allocate", body.choiceArguments)], f.j.choiceContext.disclosedContracts);
  const out = resultOf(r, "AllocationFactory_Allocate")?.output;
  const cid = out?.value?.allocationCid ?? out?.allocationCid;
  if (!cid) throw new Error("no allocationCid in " + JSON.stringify(out));
  return cid;
}
async function settleBatch(settl, legs, allocCids, actors = [EXEC]) {
  const args = { settlement: settl, transferLegs: legs, allocations: allocCids.map((c) => ({ allocationCid: c, extraTransferLegSides: [], nextIterationFunding: null })), actors, extraArgs: noExtra };
  const f = await rpost("/registry/allocation/v2/settlement-factory", { choiceArguments: args });
  if (f.status !== 200) throw new Error(`registry settlement-factory ${f.status} ${JSON.stringify(f.j)}`);
  return n.tx(actors, [ex(I_SF2, f.j.factoryId, "SettlementFactory_SettleBatch", args)], f.j.choiceContext.disclosedContracts);
}

try {
  const S0 = await supplyNow();
  const a0 = await total(ALICE), b0 = await total(BOB);
  console.log(`start: supply ${S0 / 1e6}, alice free ${a0 / 1e6}, bob free ${b0 / 1e6}`);
  const aliceInputs = (await free(ALICE)).sort((x, y) => mu(y) - mu(x)).slice(0, 1).map((c) => c.contractId);

  await group("registry advertises Allocation V2 and answers with the new factories", async () => {
    const info = await (await fetch(`http://127.0.0.1:${RP}/registry/metadata/v1/info`)).json();
    ok("allocation V2 advertised", info.supportedApis["splice-api-token-allocation-v2"] === 1 && info.supportedApis["splice-api-token-allocation-instruction-v2"] === 1);
  });

  await group("net settlement: alice pays 10, bob pays 3 (alice's NET outflow is 7)", async () => {
    const deadline = 30 * 60_000;
    const legs = [leg("L1", ALICE, BOB, 10), leg("L2", BOB, ALICE, 3)];
    const aAlloc = await allocate(ALICE, settlement, spec(ALICE, [side("L1", "SenderSide", BOB, 10), side("L2", "ReceiverSide", BOB, 3)], deadline, false), aliceInputs);
    ok("alice's allocation created", !!aAlloc);
    await sleep(1500);
    ok("only the NET 7 is locked for alice", (await lockedSum(ALICE)) === 7_000_000, `${(await lockedSum(ALICE)) / 1e6}`);
    const bAlloc = await allocate(BOB, settlement, spec(BOB, [side("L1", "ReceiverSide", ALICE, 10), side("L2", "SenderSide", ALICE, 3)], deadline, false), []);
    ok("bob's allocation created (nothing to lock: he receives more than he pays)", !!bAlloc);
    ok("supply unchanged while allocated", (await supplyNow()) === S0);

    // the guards first (nothing may move)
    let x = await refused(() => settleBatch(settlement, [leg("L1", ALICE, BOB, 11), leg("L2", BOB, ALICE, 3)], [aAlloc, bAlloc]));
    ok("a leg amount that was not authorized is refused", x.refused, x.msg.slice(-110));
    x = await refused(() => settleBatch(settlement, [leg("L1", ALICE, BOB, 10)], [aAlloc, bAlloc]));
    ok("settling fewer legs than authorized is refused", x.refused, x.msg.slice(-110));
    x = await refused(() => settleBatch({ ...settlement, id: sid + "-other" }, legs, [aAlloc, bAlloc]));
    ok("another settlement id is refused", x.refused, x.msg.slice(-110));
    x = await refused(() => settleBatch(settlement, legs, [aAlloc, bAlloc], [ALICE]));
    ok("a party that is not the executor cannot settle", x.refused, x.msg.slice(-110));
    x = await refused(() => n.tx([EXEC], [ex(I_AL2, aAlloc, "Allocation_Settle", { actors: [EXEC], extraTransferLegSides: [], nextIterationFunding: null, extraArgs: noExtra })]));
    ok("settling one allocation directly (without the admin) is refused", x.refused, x.msg.slice(-110));
    x = await refused(() => n.tx([BOB], [ex(I_AL2, aAlloc, "Allocation_Withdraw", { actors: [BOB], extraArgs: noExtra })]));
    ok("bob cannot withdraw alice's allocation", x.refused, x.msg.slice(-110));
    ok("nothing moved after the refused attempts", (await supplyNow()) === S0 && (await lockedSum(ALICE)) === 7_000_000);

    await settleBatch(settlement, legs, [aAlloc, bAlloc]);
    await sleep(2500);
    ok("alice lost exactly the net 7", (await total(ALICE)) === a0 - 7_000_000 && (await lockedSum(ALICE)) === 0, `${(await total(ALICE)) - a0}`);
    ok("bob gained exactly the net 7", (await total(BOB)) === b0 + 7_000_000, `${(await total(BOB)) - b0}`);
    ok("supply unchanged by the settlement", (await supplyNow()) === S0);
    ok("both allocations are consumed", (await n.acs(GOV, ALLOC2)).filter((c) => c.createArgument.settlement.id === sid).length === 0);
  });

  await group("committed allocation: no withdrawal before the deadline; the executor can cancel", async () => {
    const sid2 = sid + "-c";
    const s2 = { ...settlement, id: sid2 };
    const inputs = (await free(ALICE)).sort((x, y) => mu(y) - mu(x)).slice(0, 1).map((c) => c.contractId);
    const before = await total(ALICE);
    const c = await allocate(ALICE, s2, spec(ALICE, [side("L1", "SenderSide", BOB, 5)], 10 * 60_000, true), inputs);
    await sleep(1500);
    ok("5 YAP locked", (await lockedSum(ALICE)) === 5_000_000);
    let x = await refused(() => n.tx([ALICE], [ex(I_AL2, c, "Allocation_Withdraw", { actors: [ALICE], extraArgs: noExtra })]));
    ok("a committed allocation cannot be withdrawn before its deadline", x.refused, x.msg.slice(-110));
    x = await refused(() => n.tx([BOB], [ex(I_AL2, c, "Allocation_Cancel", { actors: [BOB], extraArgs: noExtra })]));
    ok("only the executor can cancel", x.refused, x.msg.slice(-110));
    await n.tx([EXEC], [ex(I_AL2, c, "Allocation_Cancel", { actors: [EXEC], extraArgs: noExtra })]);
    await sleep(2000);
    ok("the executor's cancel released the funds", (await lockedSum(ALICE)) === 0 && (await total(ALICE)) === before, `${(await total(ALICE)) - before}`);
    ok("supply unchanged", (await supplyNow()) === S0);
  });

  await group("a plain withdrawal of a non-committed allocation", async () => {
    const s3 = { ...settlement, id: sid + "-w" };
    const inputs = (await free(ALICE)).sort((x, y) => mu(y) - mu(x)).slice(0, 1).map((c) => c.contractId);
    const before = await total(ALICE);
    const c = await allocate(ALICE, s3, spec(ALICE, [side("L1", "SenderSide", BOB, 2)], 10 * 60_000, false), inputs);
    await sleep(1500);
    await n.tx([ALICE], [ex(I_AL2, c, "Allocation_Withdraw", { actors: [ALICE], extraArgs: noExtra })]);
    await sleep(2000);
    ok("alice got everything back at once", (await lockedSum(ALICE)) === 0 && (await total(ALICE)) === before);
    ok("supply unchanged", (await supplyNow()) === S0);
  });
} finally { reg.kill(); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
