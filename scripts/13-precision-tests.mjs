// v0.3.1: amounts are limited to 6 decimals (as advertised by the registry), on every entry point.
// The smallest unit 0.000001 must still work. Net balances are restored.
import { getToken, acs, submit, need, PKG } from "./lib.mjs";

const admin = need("CUSDT_ADMIN_PARTY");
const suffix = admin.split("::")[1];
const ALICE = `cusdt-alice::${suffix}`, BOB = `cusdt-bob::${suffix}`;
const registry = process.env.CUSDT_REGISTRY_URL || "http://localhost:8787";
const token = await getToken();
const HOLDING = `${PKG}:CusdtToken:CusdtHolding`;
const ADMINT = `${PKG}:CusdtToken:CusdtAdmin`;
const INSTR = `${PKG}:CusdtToken:CusdtTransferInstruction`;
const IF_TF = "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory";
const IF_TI = "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction";
const IF_AF = "#splice-api-token-allocation-instruction-v1:Splice.Api.Token.AllocationInstructionV1:AllocationFactory";
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const extra = { extraArgs: { context: { values: {} }, meta: { values: {} } } };

const held = async (p) => (await acs(token, p, HOLDING)).filter((c) => c.createArgument.owner === p && c.createArgument.lock == null);
const total = (hs) => hs.reduce((s, h) => s + Number(h.createArgument.amount), 0);
const post = async (path, body) => (await fetch(`${registry}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();

async function transfer(sender, receiver, amount) {
  const t = { sender, receiver, amount, instrumentId: { admin, id: "cUSDT" }, requestedAt: iso(-30_000), executeBefore: iso(3_600_000),
    inputHoldingCids: (await held(sender)).map((h) => h.contractId), meta: { values: {} } };
  const f = await post("/registry/transfer-instruction/v1/transfer-factory", { choiceArguments: { expectedAdmin: admin, transfer: t } });
  return submit(token, { actAs: [sender], label: "prec", disclosedContracts: f.choiceContext.disclosedContracts,
    commands: [{ ExerciseCommand: { templateId: IF_TF, contractId: f.factoryId, choice: "TransferFactory_Transfer",
      choiceArgument: { expectedAdmin: admin, transfer: t, extraArgs: { context: f.choiceContext.choiceContextData, meta: { values: {} } } } } }] });
}
async function allocate(sender, receiver, amount) {
  const spec = { settlement: { executor: admin, settlementRef: { id: `prec-${Date.now()}`, cid: null }, requestedAt: iso(-30_000), allocateBefore: iso(600_000), settleBefore: iso(1_200_000), meta: { values: {} } },
    transferLegId: "leg-1", transferLeg: { sender, receiver, amount, instrumentId: { admin, id: "cUSDT" }, meta: { values: {} } } };
  const args = { expectedAdmin: admin, allocation: spec, requestedAt: iso(-30_000), inputHoldingCids: (await held(sender)).map((h) => h.contractId) };
  const f = await post("/registry/allocation-instruction/v1/allocation-factory", { choiceArguments: args });
  return submit(token, { actAs: [sender], label: "prec-al", disclosedContracts: f.choiceContext.disclosedContracts,
    commands: [{ ExerciseCommand: { templateId: IF_AF, contractId: f.factoryId, choice: "AllocationFactory_Allocate",
      choiceArgument: { ...args, extraArgs: { context: f.choiceContext.choiceContextData, meta: { values: {} } } } } }] });
}

let pass = 0, fail = 0;
const ok = (n, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  — " + x : ""}`); };
async function mustFail(name, want, fn) {
  try { await fn(); ok(name, false, "unexpectedly succeeded"); }
  catch (e) { const m = String(e.message).replace(/\s+/g, " "); const hit = new RegExp(want, "i").test(m); ok(name, hit, hit ? `rejected ("${want}")` : `other reason: ${m.slice(0, 220)}`); }
}

const A0 = total(await held(ALICE)), B0 = total(await held(BOB));
console.log(`start: alice ${A0}, bob ${B0}\n`);

await mustFail("transfer with 7 decimals", "more than 6 decimals", () => transfer(ALICE, BOB, "1.0000001000"));
await mustFail("transfer of 10 decimals", "more than 6 decimals", () => transfer(ALICE, BOB, "0.1234567891"));
await mustFail("allocation with 7 decimals", "more than 6 decimals", () => allocate(ALICE, BOB, "1.0000001000"));
await mustFail("mint with 7 decimals", "more than 6 decimals", async () => {
  const [a] = await acs(token, admin, ADMINT);
  return submit(token, { actAs: [admin], label: "prec-mint", commands: [{ ExerciseCommand: { templateId: ADMINT, contractId: a.contractId,
    choice: "CusdtAdmin_Mint", choiceArgument: { recipient: ALICE, amount: "0.0000001000" } } }] });
});
await mustFail("split with 7 decimals", "more than 6 decimals", async () => {
  const [h] = await held(ALICE);
  return submit(token, { actAs: [ALICE], label: "prec-split", commands: [{ ExerciseCommand: { templateId: HOLDING, contractId: h.contractId,
    choice: "CusdtHolding_Split", choiceArgument: { splitAmount: "0.0000001000" } } }] });
});
ok("failed attempts changed nothing", total(await held(ALICE)) === A0 && total(await held(BOB)) === B0);

// smallest unit still works (offer + accept), then send it back
async function sendAndAccept(from, to, amount) {
  await transfer(from, to, amount);
  const ti = (await acs(token, to, INSTR)).find((c) => c.createArgument.transfer.sender === from);
  await submit(token, { actAs: [to], label: "prec-acc", commands: [{ ExerciseCommand: { templateId: IF_TI, contractId: ti.contractId,
    choice: "TransferInstruction_Accept", choiceArgument: extra } }] });
}
await sendAndAccept(ALICE, BOB, "0.000001");
ok("0.000001 (smallest unit) transfers", Math.abs(total(await held(BOB)) - (B0 + 0.000001)) < 1e-9);
await sendAndAccept(BOB, ALICE, "0.000001");
ok("balances restored", Math.abs(total(await held(ALICE)) - A0) < 1e-9 && Math.abs(total(await held(BOB)) - B0) < 1e-9);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
