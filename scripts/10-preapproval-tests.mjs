// Direct-transfer (preapproval) behaviour on testnet. Leaves bob WITHOUT a preapproval and balances unchanged.
//   1. bob has a preapproval  -> alice->bob is "direct", no accept step, funds land immediately
//   2. bob's preapproval used for a transfer to alice (wrong receiver)   -> must fail
//   3. a made-up preapproval cid in the context                          -> must fail
//   4. bob cancels his preapproval -> next alice->bob is an "offer" again (bob rejects it to clean up)
import { getToken, acs, submit, need, PKG } from "./lib.mjs";

const admin = need("CUSDT_ADMIN_PARTY");
const suffix = admin.split("::")[1];
const ALICE = (process.env.CUSDT_ALICE || `cusdt-alice::${suffix}`), BOB = (process.env.CUSDT_BOB || `cusdt-bob::${suffix}`);
const registry = process.env.CUSDT_REGISTRY_URL || "http://localhost:8787";
const token = await getToken();
const HOLDING = `${PKG}:YapToken:YapHolding`;
const PRE = `${PKG}:YapToken:YapTransferPreapproval`;
const INSTR = `${PKG}:YapToken:YapTransferInstruction`;
const KEY = "cusdt.mahawallet.xyz/transfer-preapproval";
const IFACE_TF = "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory";
const IFACE_TI = "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction";

const held = async (p) => (await acs(token, p, HOLDING)).filter((c) => c.createArgument.owner === p);
const total = (hs) => hs.reduce((s, h) => s + Number(h.createArgument.amount), 0);
const mk = (sender, receiver, amount, inputs) => ({
  sender, receiver, amount: Number(amount).toFixed(10), instrumentId: { admin, id: "YAP" },
  requestedAt: new Date(Date.now() - 30_000).toISOString(), executeBefore: new Date(Date.now() + 3_600_000).toISOString(),
  inputHoldingCids: inputs.map((h) => h.contractId), meta: { values: {} },
});
const factory = async (transfer) => (await fetch(`${registry}/registry/transfer-instruction/v1/transfer-factory`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ choiceArguments: { expectedAdmin: admin, transfer } }) })).json();
const exerciseTransfer = (actAs, f, transfer, ctxValues, extraDisclosed = []) => submit(token, {
  actAs: [actAs], label: "p", disclosedContracts: [...f.choiceContext.disclosedContracts, ...extraDisclosed],
  commands: [{ ExerciseCommand: { templateId: IFACE_TF, contractId: f.factoryId, choice: "TransferFactory_Transfer",
    choiceArgument: { expectedAdmin: admin, transfer, extraArgs: { context: { values: ctxValues }, meta: { values: {} } } } } }] });

let pass = 0, fail = 0;
const ok = (n, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  — " + x : ""}`); };
async function mustFail(name, want, fn) {
  try { await fn(); ok(name, false, "unexpectedly succeeded"); }
  catch (e) {
    const m = String(e.message).replace(/\s+/g, " ");
    ok(name, new RegExp(want, "i").test(m), new RegExp(want, "i").test(m) ? `Daml assert hit ("${want}")` : `other reason: ${m.slice(0, 220)}`);
  }
}

const a0 = total(await held(ALICE)), b0 = total(await held(BOB));
console.log(`start: alice ${a0}, bob ${b0}`);
const bobPre = async () => (await acs(token, admin, PRE, { blob: true })).filter((c) => c.createArgument.receiver === BOB);
if (!(await bobPre()).length) throw new Error("bob has no preapproval; run 9-preapprove.mjs first");

// 1. direct
{
  const t = mk(ALICE, BOB, 1, await held(ALICE));
  const f = await factory(t);
  ok("registry reports kind=direct", f.transferKind === "direct", f.transferKind);
  await exerciseTransfer(ALICE, f, t, f.choiceContext.choiceContextData.values);
  ok("direct: bob credited with no accept step", total(await held(BOB)) === b0 + 1 && total(await held(ALICE)) === a0 - 1);
  // give it back (bob->alice also direct? alice has no preapproval -> offer, alice accepts)
  const tb = mk(BOB, ALICE, 1, await held(BOB));
  const fb = await factory(tb);
  ok("alice has no preapproval -> kind=offer", fb.transferKind === "offer", fb.transferKind);
  await exerciseTransfer(BOB, fb, tb, fb.choiceContext.choiceContextData.values);
  const ti = (await acs(token, ALICE, INSTR)).find((c) => c.createArgument.transfer.sender === BOB);
  await submit(token, { actAs: [ALICE], label: "acc", commands: [{ ExerciseCommand: { templateId: IFACE_TI, contractId: ti.contractId,
    choice: "TransferInstruction_Accept", choiceArgument: { extraArgs: { context: { values: {} }, meta: { values: {} } } } } }] });
  ok("balances restored", total(await held(ALICE)) === a0 && total(await held(BOB)) === b0);
}

// 2. bob's preapproval used for a transfer to alice
{
  const [pre] = await bobPre();
  const t = mk(BOB, ALICE, 1, await held(BOB));
  const f = await factory(t);
  await mustFail("another receiver's preapproval is rejected", "different receiver", () =>
    exerciseTransfer(BOB, f, t, { [KEY]: { tag: "AV_ContractId", value: pre.contractId } },
      [{ templateId: pre.templateId, contractId: pre.contractId, createdEventBlob: pre.createdEventBlob, synchronizerId: pre.synchronizerId }]));
}

// 3. made-up cid
{
  const t = mk(ALICE, BOB, 1, await held(ALICE));
  const f = await factory(t);
  await mustFail("made-up preapproval cid is rejected", ".", () =>
    exerciseTransfer(ALICE, f, t, { [KEY]: { tag: "AV_ContractId", value: "00" + "ab".repeat(33) } }));
}

// 4. cancel -> offer again
{
  const [pre] = await bobPre();
  await submit(token, { actAs: [BOB], label: "cancel", commands: [{ ExerciseCommand: { templateId: PRE, contractId: pre.contractId,
    choice: "YapTransferPreapproval_Cancel", choiceArgument: {} } }] });
  ok("receiver can cancel own preapproval", (await bobPre()).length === 0);
  const t = mk(ALICE, BOB, 1, await held(ALICE));
  const f = await factory(t);
  ok("after cancel registry reports kind=offer", f.transferKind === "offer", f.transferKind);
  await exerciseTransfer(ALICE, f, t, f.choiceContext.choiceContextData.values);
  const ti = (await acs(token, BOB, INSTR)).find((c) => c.createArgument.transfer.sender === ALICE);
  ok("transfer is pending, bob not credited yet", !!ti && total(await held(BOB)) === b0);
  await submit(token, { actAs: [BOB], label: "rej", commands: [{ ExerciseCommand: { templateId: IFACE_TI, contractId: ti.contractId,
    choice: "TransferInstruction_Reject", choiceArgument: { extraArgs: { context: { values: {} }, meta: { values: {} } } } } }] });
  ok("balances restored after reject", total(await held(ALICE)) === a0 && total(await held(BOB)) === b0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
