// Closes the two gaps left by 6-negative-tests: make the Daml ownership asserts reachable by
// DISCLOSING a foreign holding to the caller (otherwise Canton privacy rejects first).
//   1. bob spends alice's disclosed holding  -> must fail with "not owned by sender"
//   2. alice merges bob's disclosed holding  -> must fail with "owner mismatch"
import { getToken, acs, submit, need, PKG } from "./lib.mjs";

const admin = need("CUSDT_ADMIN_PARTY");
const suffix = admin.split("::")[1];
const ALICE = `cusdt-alice::${suffix}`, BOB = `cusdt-bob::${suffix}`;
const registry = process.env.CUSDT_REGISTRY_URL || "http://localhost:8787";
const token = await getToken();
const HOLDING = `${PKG}:YapToken:YapHolding`;
const IFACE_TF = "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory";

const held = async (p) => (await acs(token, p, HOLDING, { blob: true })).filter((c) => c.createArgument.owner === p);
const total = (hs) => hs.reduce((s, h) => s + Number(h.createArgument.amount), 0);
const disclose = (c) => ({ templateId: c.templateId, contractId: c.contractId, createdEventBlob: c.createdEventBlob, synchronizerId: c.synchronizerId });

const a0 = await held(ALICE), b0 = await held(BOB);
const A0 = total(a0), B0 = total(b0);
console.log(`start: alice ${A0} (${a0.length}), bob ${B0} (${b0.length})`);

let pass = 0, fail = 0;
async function mustFail(name, want, fn) {
  try { await fn(); fail++; console.log(`FAIL  ${name}  — unexpectedly succeeded`); }
  catch (e) {
    const msg = String(e.message).replace(/\s+/g, " ");
    if (new RegExp(want, "i").test(msg)) { pass++; console.log(`PASS  ${name}  — Daml assert hit ("${want}")`); }
    else { fail++; console.log(`FAIL  ${name}  — rejected for another reason: ${msg.slice(0, 260)}`); }
  }
}

// 1. bob tries to spend alice's holding (disclosed to him)
await mustFail("spend a disclosed holding owned by someone else", "not owned by sender", async () => {
  const transfer = {
    sender: BOB, receiver: ALICE, amount: "1.0000000000", instrumentId: { admin, id: "YAP" },
    requestedAt: new Date(Date.now() - 30_000).toISOString(), executeBefore: new Date(Date.now() + 3_600_000).toISOString(),
    inputHoldingCids: a0.map((h) => h.contractId), meta: { values: {} },
  };
  const fr = await fetch(`${registry}/registry/transfer-instruction/v1/transfer-factory`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ choiceArguments: { expectedAdmin: admin, transfer } }) });
  const f = await fr.json();
  return submit(token, { actAs: [BOB], label: "disc-spend",
    disclosedContracts: [...f.choiceContext.disclosedContracts, ...a0.map(disclose)],
    commands: [{ ExerciseCommand: { templateId: IFACE_TF, contractId: f.factoryId, choice: "TransferFactory_Transfer",
      choiceArgument: { expectedAdmin: admin, transfer, extraArgs: { context: f.choiceContext.choiceContextData, meta: { values: {} } } } } }] });
});

// 2. alice tries to merge bob's holding into hers (disclosed to her)
await mustFail("merge a disclosed holding owned by someone else", "owner mismatch", () =>
  submit(token, { actAs: [ALICE], label: "disc-merge", disclosedContracts: b0.map(disclose),
    commands: [{ ExerciseCommand: { templateId: HOLDING, contractId: a0[0].contractId, choice: "YapHolding_Merge",
      choiceArgument: { otherCids: b0.map((h) => h.contractId) } } }] }));

const a1 = await held(ALICE), b1 = await held(BOB);
const same = total(a1) === A0 && total(b1) === B0;
console.log(`${same ? "PASS" : "FAIL"}  balances unchanged: alice ${total(a1)}, bob ${total(b1)}`);
same ? pass++ : fail++;
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
