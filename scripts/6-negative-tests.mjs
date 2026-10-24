// Behavioural tests against the deployed YAP contracts + registry (testnet).
// Needs cusdt-alice with a few YAP and cusdt-bob (see 3-mint / 4-e2e-test).
// Net balances are restored; every negative case must FAIL on-ledger, every positive case must pass.
import { getToken, acs, submit, need, env, PKG } from "./lib.mjs";

const admin = need("CUSDT_ADMIN_PARTY");
const suffix = admin.split("::")[1];
const ALICE = `cusdt-alice::${suffix}`, BOB = `cusdt-bob::${suffix}`;
const registry = process.env.CUSDT_REGISTRY_URL || "http://localhost:8787";
const token = await getToken();
const HOLDING = `${PKG}:YapToken:YapHolding`;
const INSTR = `${PKG}:YapToken:YapTransferInstruction`;
const IFACE_TF = "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory";
const IFACE_TI = "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const holdings = async (p) => (await acs(token, p, HOLDING)).filter((c) => c.createArgument.owner === p);
const total = (hs) => hs.reduce((s, h) => s + Number(h.createArgument.amount), 0);
const pendingFor = async (receiver, sender) =>
  (await acs(token, receiver, INSTR)).filter((c) => c.createArgument.transfer.sender === sender);

const mkTransfer = (sender, receiver, amount, inputs, o = {}) => ({
  sender, receiver, amount: Number(amount).toFixed(10),
  instrumentId: o.instrumentId ?? { admin, id: "YAP" },
  requestedAt: o.requestedAt ?? new Date(Date.now() - 30_000).toISOString(),
  executeBefore: o.executeBefore ?? new Date(Date.now() + 3_600_000).toISOString(),
  inputHoldingCids: inputs.map((h) => h.contractId ?? h), meta: { values: {} },
});
async function factoryFor(transfer) {
  const r = await fetch(`${registry}/registry/transfer-instruction/v1/transfer-factory`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ choiceArguments: { expectedAdmin: admin, transfer: { ...transfer, instrumentId: { admin, id: "YAP" } } } }),
  });
  if (!r.ok) throw new Error(`registry ${r.status}`);
  return r.json();
}
async function doTransfer(actAs, transfer, { expectedAdmin = admin } = {}) {
  const f = await factoryFor(transfer);
  return submit(token, {
    actAs: [actAs], label: "t", disclosedContracts: f.choiceContext.disclosedContracts,
    commands: [{ ExerciseCommand: { templateId: IFACE_TF, contractId: f.factoryId, choice: "TransferFactory_Transfer",
      choiceArgument: { expectedAdmin, transfer, extraArgs: { context: f.choiceContext.choiceContextData, meta: { values: {} } } } } }],
  });
}
const act = (actAs, cid, choice) => submit(token, {
  actAs: [actAs], label: choice,
  commands: [{ ExerciseCommand: { templateId: IFACE_TI, contractId: cid, choice,
    choiceArgument: { extraArgs: { context: { values: {} }, meta: { values: {} } } } } }],
});

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { (cond ? pass++ : fail++); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); };
async function mustFail(name, fn, wantMsg) {
  try { await fn(); ok(name, false, "unexpectedly succeeded"); }
  catch (e) {
    const msg = String(e.message);
    const matched = wantMsg ? new RegExp(wantMsg, "i").test(msg) : true;
    ok(name, true, matched ? `rejected (${wantMsg ?? "any"})` : `rejected, message differs: ${msg.replace(/\s+/g, " ").slice(-110)}`);
  }
}

const a0 = await holdings(ALICE), b0 = await holdings(BOB);
const A0 = total(a0), B0 = total(b0);
console.log(`start: alice ${A0} (${a0.length} holdings), bob ${B0} (${b0.length} holdings)\n`);
if (A0 < 5) throw new Error("alice needs >= 5 YAP");

// ---- negative: transfer rules ----
await mustFail("insufficient inputs", () => doTransfer(ALICE, mkTransfer(ALICE, BOB, A0 + 1, a0)), "insufficient funds");
await mustFail("input owned by someone else", () => doTransfer(BOB, mkTransfer(BOB, ALICE, 1, a0)), "not owned by sender");
await mustFail("executeBefore in the past", () => doTransfer(ALICE, mkTransfer(ALICE, BOB, 1, a0, { executeBefore: new Date(Date.now() - 60_000).toISOString() })), "executeBefore");
await mustFail("requestedAt in the future", () => doTransfer(ALICE, mkTransfer(ALICE, BOB, 1, a0, { requestedAt: new Date(Date.now() + 3_600_000).toISOString() })), "requestedAt");
await mustFail("wrong expectedAdmin", () => doTransfer(ALICE, mkTransfer(ALICE, BOB, 1, a0), { expectedAdmin: BOB }), "expectedAdmin");
await mustFail("wrong instrument id", async () => {
  const t = mkTransfer(ALICE, BOB, 1, a0, { instrumentId: { admin, id: "YAP2" } });
  const f = await factoryFor(mkTransfer(ALICE, BOB, 1, a0));
  return submit(token, { actAs: [ALICE], label: "wi", disclosedContracts: f.choiceContext.disclosedContracts,
    commands: [{ ExerciseCommand: { templateId: IFACE_TF, contractId: f.factoryId, choice: "TransferFactory_Transfer",
      choiceArgument: { expectedAdmin: admin, transfer: t, extraArgs: { context: f.choiceContext.choiceContextData, meta: { values: {} } } } } }] });
}, "wrong instrument");
await mustFail("no input holdings given", () => doTransfer(ALICE, mkTransfer(ALICE, BOB, 1, [])), "inputHoldingCids");
ok("balances untouched by failed attempts", total(await holdings(ALICE)) === A0 && total(await holdings(BOB)) === B0);

// ---- positive + authorization: reject / withdraw / wrong accepter ----
let known = new Set((await pendingFor(BOB, ALICE)).map((c) => c.contractId));
await doTransfer(ALICE, mkTransfer(ALICE, BOB, 1, await holdings(ALICE)));
let ti = (await pendingFor(BOB, ALICE)).find((c) => !known.has(c.contractId));
ok("transfer creates pending instruction", !!ti);
await mustFail("third party (alice) cannot accept bob's instruction", () => act(ALICE, ti.contractId, "TransferInstruction_Accept"));
await act(BOB, ti.contractId, "TransferInstruction_Reject");
ok("reject returns funds to sender", total(await holdings(ALICE)) === A0 && total(await holdings(BOB)) === B0);

known = new Set((await pendingFor(BOB, ALICE)).map((c) => c.contractId));
await doTransfer(ALICE, mkTransfer(ALICE, BOB, 1, await holdings(ALICE)));
ti = (await pendingFor(BOB, ALICE)).find((c) => !known.has(c.contractId));
await mustFail("receiver (bob) cannot withdraw", () => act(BOB, ti.contractId, "TransferInstruction_Withdraw"));
await act(ALICE, ti.contractId, "TransferInstruction_Withdraw");
ok("withdraw returns funds to sender", total(await holdings(ALICE)) === A0 && total(await holdings(BOB)) === B0);

// ---- expiry: accept after executeBefore must fail, withdraw still works ----
known = new Set((await pendingFor(BOB, ALICE)).map((c) => c.contractId));
await doTransfer(ALICE, mkTransfer(ALICE, BOB, 1, await holdings(ALICE), { executeBefore: new Date(Date.now() + 20_000).toISOString() }));
ti = (await pendingFor(BOB, ALICE)).find((c) => !known.has(c.contractId));
console.log("      waiting 25s for the transfer to expire ...");
await sleep(25_000);
await mustFail("accept after expiry", () => act(BOB, ti.contractId, "TransferInstruction_Accept"), "expired");
await act(ALICE, ti.contractId, "TransferInstruction_Withdraw");
ok("withdraw after expiry still works", total(await holdings(ALICE)) === A0);

// ---- self transfer + merge ----
await doTransfer(ALICE, mkTransfer(ALICE, ALICE, 1, await holdings(ALICE)));
const aS = await holdings(ALICE);
ok("self transfer completes immediately, total unchanged", total(aS) === A0, `${aS.length} holdings`);
if (aS.length >= 2) {
  const [first, ...rest] = aS;
  await submit(token, { actAs: [ALICE], label: "merge", commands: [{ ExerciseCommand: {
    templateId: HOLDING, contractId: first.contractId, choice: "YapHolding_Merge",
    choiceArgument: { otherCids: rest.map((h) => h.contractId) } } }] });
  const aM = await holdings(ALICE);
  ok("merge consolidates to one holding, total unchanged", aM.length === 1 && total(aM) === A0, `${aS.length} -> ${aM.length}`);
} else ok("merge (skipped: <2 holdings)", true);

const bH = await holdings(BOB);
if (bH.length >= 2) {
  const [, ...rest] = bH;
  await mustFail("cannot merge another owner's holdings", async () => submit(token, { actAs: [ALICE], label: "badmerge", commands: [{ ExerciseCommand: {
    templateId: HOLDING, contractId: (await holdings(ALICE))[0].contractId, choice: "YapHolding_Merge",
    choiceArgument: { otherCids: rest.map((h) => h.contractId) } } }] }), "owner mismatch");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
