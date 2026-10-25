// Allocation / settlement behaviour on testnet (v0.3.0). Executor = the admin party.
// Alice needs >= 30 spendable YAP. Net balances are restored except the executed 10 (alice -> bob),
// which is sent back at the end.
import { getToken, acs, submit, need, PKG } from "./lib.mjs";

const admin = need("CUSDT_ADMIN_PARTY");
const suffix = admin.split("::")[1];
const ALICE = (process.env.CUSDT_ALICE || `cusdt-alice::${suffix}`), BOB = (process.env.CUSDT_BOB || `cusdt-bob::${suffix}`);
const registry = process.env.CUSDT_REGISTRY_URL || "http://localhost:8787";
const token = await getToken();
const HOLDING = `${PKG}:YapToken:YapHolding`;
const ALLOC = `${PKG}:YapToken:YapAllocation`;
const IF_AF = "#splice-api-token-allocation-instruction-v1:Splice.Api.Token.AllocationInstructionV1:AllocationFactory";
const IF_A = "#splice-api-token-allocation-v1:Splice.Api.Token.AllocationV1:Allocation";
const IF_TF = "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (ms) => new Date(Date.now() + ms).toISOString();

const all = async (p) => (await acs(token, p, HOLDING)).filter((c) => c.createArgument.owner === p);
const free = async (p) => (await all(p)).filter((c) => c.createArgument.lock == null);
const sum = (hs) => hs.reduce((s, h) => s + Number(h.createArgument.amount), 0);

let n = 0;
function spec(sender, receiver, amount, o = {}) {
  return {
    settlement: { executor: admin, settlementRef: { id: o.ref ?? `alloc-test-${Date.now()}-${n++}`, cid: null },
      requestedAt: iso(-30_000), allocateBefore: o.allocateBefore ?? iso(600_000), settleBefore: o.settleBefore ?? iso(1_200_000), meta: { values: {} } },
    transferLegId: "leg-1",
    transferLeg: { sender, receiver, amount: Number(amount).toFixed(10), instrumentId: o.instrumentId ?? { admin, id: "YAP" }, meta: { values: {} } },
  };
}
async function allocate(actAs, sp, inputs, o = {}) {
  const args = { expectedAdmin: o.expectedAdmin ?? admin, allocation: sp, requestedAt: iso(-30_000), inputHoldingCids: inputs.map((h) => h.contractId) };
  const fr = await fetch(`${registry}/registry/allocation-instruction/v1/allocation-factory`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ choiceArguments: { ...args, expectedAdmin: admin, allocation: { ...sp, transferLeg: { ...sp.transferLeg, instrumentId: { admin, id: "YAP" } } } } }) });
  if (!fr.ok) throw new Error(`registry ${fr.status}`);
  const f = await fr.json();
  return submit(token, { actAs: [actAs], label: "alloc", disclosedContracts: f.choiceContext.disclosedContracts,
    commands: [{ ExerciseCommand: { templateId: IF_AF, contractId: f.factoryId, choice: "AllocationFactory_Allocate",
      choiceArgument: { ...args, extraArgs: { context: f.choiceContext.choiceContextData, meta: { values: {} } } } } }] });
}
const findAlloc = async (sender, ref) =>
  (await acs(token, sender, ALLOC)).find((c) => c.createArgument.allocation.settlement.settlementRef.id === ref);
const extra = { extraArgs: { context: { values: {} }, meta: { values: {} } } };
const exercise = (actAs, cid, choice) => submit(token, { actAs, label: choice,
  commands: [{ ExerciseCommand: { templateId: IF_A, contractId: cid, choice, choiceArgument: extra } }] });

let pass = 0, fail = 0;
const ok = (name, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}  ${name}${x ? "  — " + x : ""}`); };
async function mustFail(name, want, fn) {
  try { await fn(); ok(name, false, "unexpectedly succeeded"); }
  catch (e) {
    const m = String(e.message).replace(/\s+/g, " ");
    const hit = want ? new RegExp(want, "i").test(m) : true;
    ok(name, hit, hit ? `rejected${want ? ` ("${want}")` : ""}` : `other reason: ${m.slice(0, 200)}`);
  }
}

const A0 = sum(await all(ALICE)), B0 = sum(await all(BOB));
console.log(`start: alice ${A0}, bob ${B0}\n`);
if (sum(await free(ALICE)) < 30) throw new Error("alice needs >= 30 spendable YAP");

// A. allocate -> funds locked
let sp = spec(ALICE, BOB, 10);
await allocate(ALICE, sp, await free(ALICE));
let al = await findAlloc(ALICE, sp.settlement.settlementRef.id);
const locked = (await all(ALICE)).filter((c) => c.createArgument.lock != null);
ok("allocation created", !!al);
ok("10 locked in a locked holding, rest spendable", locked.length === 1 && sum(locked) === 10 && sum(await free(ALICE)) === A0 - 10);
ok("allocation view lists the locked holding", al.createArgument.lockedCid === locked[0].contractId);

// B. locked funds cannot be spent
await mustFail("locked holding cannot be used as transfer input", "locked", async () => {
  const t = { sender: ALICE, receiver: BOB, amount: "1.0000000000", instrumentId: { admin, id: "YAP" },
    requestedAt: iso(-30_000), executeBefore: iso(3_600_000), inputHoldingCids: [locked[0].contractId], meta: { values: {} } };
  const f = await (await fetch(`${registry}/registry/transfer-instruction/v1/transfer-factory`, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ choiceArguments: { expectedAdmin: admin, transfer: t } }) })).json();
  return submit(token, { actAs: [ALICE], label: "spend-locked", disclosedContracts: f.choiceContext.disclosedContracts,
    commands: [{ ExerciseCommand: { templateId: IF_TF, contractId: f.factoryId, choice: "TransferFactory_Transfer",
      choiceArgument: { expectedAdmin: admin, transfer: t, extraArgs: { context: f.choiceContext.choiceContextData, meta: { values: {} } } } } }] });
});

// C. execute needs executor + sender + receiver
await mustFail("execute without the receiver's authority fails", null, () => exercise([admin, ALICE], al.contractId, "Allocation_ExecuteTransfer"));
await exercise([admin, ALICE, BOB], al.contractId, "Allocation_ExecuteTransfer");
ok("execute: bob +10, locked holding consumed, allocation gone",
  sum(await all(BOB)) === B0 + 10 && (await all(ALICE)).every((c) => c.createArgument.lock == null) && !(await findAlloc(ALICE, sp.settlement.settlementRef.id)));
ok("alice total reduced by 10 only", sum(await all(ALICE)) === A0 - 10);

// D. sender withdraws alone
sp = spec(ALICE, BOB, 7);
await allocate(ALICE, sp, await free(ALICE));
al = await findAlloc(ALICE, sp.settlement.settlementRef.id);
await exercise([ALICE], al.contractId, "Allocation_Withdraw");
ok("withdraw by sender alone returns the funds", sum(await free(ALICE)) === A0 - 10 && (await all(ALICE)).every((c) => c.createArgument.lock == null));

// E. cancel needs all three
sp = spec(ALICE, BOB, 7);
await allocate(ALICE, sp, await free(ALICE));
al = await findAlloc(ALICE, sp.settlement.settlementRef.id);
await mustFail("cancel by sender alone fails", null, () => exercise([ALICE], al.contractId, "Allocation_Cancel"));
await exercise([admin, ALICE, BOB], al.contractId, "Allocation_Cancel");
ok("cancel by all three returns the funds", sum(await free(ALICE)) === A0 - 10);

// F. expiry
sp = spec(ALICE, BOB, 5, { allocateBefore: iso(8_000), settleBefore: iso(18_000) });
await allocate(ALICE, sp, await free(ALICE));
al = await findAlloc(ALICE, sp.settlement.settlementRef.id);
console.log("      waiting 22s for settleBefore to pass ...");
await sleep(22_000);
await mustFail("execute after settleBefore fails", "settleBefore", () => exercise([admin, ALICE, BOB], al.contractId, "Allocation_ExecuteTransfer"));
await exercise([ALICE], al.contractId, "Allocation_Withdraw");
ok("withdraw after expiry still works", sum(await free(ALICE)) === A0 - 10);

// G. validation
const inputs = await free(ALICE);
await mustFail("wrong expectedAdmin", "expectedAdmin", async () => {
  const s = spec(ALICE, BOB, 1); const args = { expectedAdmin: BOB, allocation: s, requestedAt: iso(-30_000), inputHoldingCids: inputs.map((h) => h.contractId), ...extra };
  const f = await (await fetch(`${registry}/registry/allocation-instruction/v1/allocation-factory`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ choiceArguments: { ...args, expectedAdmin: admin } }) })).json();
  return submit(token, { actAs: [ALICE], label: "wa", disclosedContracts: f.choiceContext.disclosedContracts,
    commands: [{ ExerciseCommand: { templateId: IF_AF, contractId: f.factoryId, choice: "AllocationFactory_Allocate", choiceArgument: args } }] });
});
await mustFail("insufficient funds", "insufficient funds", () => allocate(ALICE, spec(ALICE, BOB, A0 + 100), inputs));
await mustFail("allocateBefore in the past", "allocateBefore", () => allocate(ALICE, spec(ALICE, BOB, 1, { allocateBefore: iso(-60_000), settleBefore: iso(60_000) }), inputs));
await mustFail("settleBefore not after allocateBefore", "settleBefore", () => allocate(ALICE, spec(ALICE, BOB, 1, { allocateBefore: iso(60_000), settleBefore: iso(30_000) }), inputs));
await mustFail("no input holdings", "inputHoldingCids", () => allocate(ALICE, spec(ALICE, BOB, 1), []));
await mustFail("someone else cannot allocate alice's funds", null, () => allocate(BOB, spec(ALICE, BOB, 1), inputs));
ok("balances untouched by failed attempts", sum(await free(ALICE)) === A0 - 10);

// restore: bob returns the 10
{
  const bobFree = await free(BOB);
  const t = { sender: BOB, receiver: ALICE, amount: "10.0000000000", instrumentId: { admin, id: "YAP" },
    requestedAt: iso(-30_000), executeBefore: iso(3_600_000), inputHoldingCids: bobFree.map((h) => h.contractId), meta: { values: {} } };
  const f = await (await fetch(`${registry}/registry/transfer-instruction/v1/transfer-factory`, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ choiceArguments: { expectedAdmin: admin, transfer: t } }) })).json();
  await submit(token, { actAs: [BOB], label: "restore", disclosedContracts: f.choiceContext.disclosedContracts,
    commands: [{ ExerciseCommand: { templateId: IF_TF, contractId: f.factoryId, choice: "TransferFactory_Transfer",
      choiceArgument: { expectedAdmin: admin, transfer: t, extraArgs: { context: f.choiceContext.choiceContextData, meta: { values: {} } } } } }] });
  const IF_TI = "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction";
  const ti = (await acs(token, ALICE, `${PKG}:YapToken:YapTransferInstruction`)).find((c) => c.createArgument.transfer.sender === BOB);
  if (ti) await submit(token, { actAs: [ALICE], label: "restore-acc", commands: [{ ExerciseCommand: { templateId: IF_TI, contractId: ti.contractId,
    choice: "TransferInstruction_Accept", choiceArgument: extra } }] });
  console.log(`restored: alice ${sum(await all(ALICE))}, bob ${sum(await all(BOB))} (started ${A0}/${B0})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
