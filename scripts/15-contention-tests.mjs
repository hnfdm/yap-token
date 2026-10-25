// Concurrency / double-spend behaviour on testnet. Every race fires its commands in the same tick
// and counts how many the ledger accepted; conflicting commands that consume the same contract must
// yield EXACTLY ONE success. After every scenario the conservation invariants are re-checked.
//   A  2 transfers spending one holding            B  6 transfers spending one holding
//   C  transfer vs allocate on one holding         D  accept / reject / withdraw one instruction
//   E  execute / withdraw / cancel one allocation  F  split vs transfer; overlapping merges
//   G  same commandId twice (deduplication)        H  5 independent transfers: ALL must succeed
import { getToken, acs, submit, need, PKG } from "./lib.mjs";
import { T, mu, snapshot, supply, checkInvariants, retry } from "./invariants.mjs";

const admin = need("CUSDT_ADMIN_PARTY");
const suffix = admin.split("::")[1];
const ALICE = (process.env.CUSDT_ALICE || `cusdt-alice::${suffix}`), BOB = (process.env.CUSDT_BOB || `cusdt-bob::${suffix}`);
const registry = process.env.CUSDT_REGISTRY_URL || "http://localhost:8787";
const token = await getToken();
const IF_TF = "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory";
const IF_TI = "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction";
const IF_AF = "#splice-api-token-allocation-instruction-v1:Splice.Api.Token.AllocationInstructionV1:AllocationFactory";
const IF_A = "#splice-api-token-allocation-v1:Splice.Api.Token.AllocationV1:Allocation";
const extra = { extraArgs: { context: { values: {} }, meta: { values: {} } } };
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const amt = (m) => (m / 1e6).toFixed(10);
const snap = () => snapshot(token, admin);
const free = (S, p) => S.H.filter((h) => h.createArgument.owner === p && h.createArgument.lock == null).sort((a, b) => mu(b.createArgument.amount) - mu(a.createArgument.amount));
const post = (path, body) => retry(async () => { const r = await fetch(`${registry}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); if (!r.ok) throw new Error(`registry ${r.status}`); return r.json(); });

// ---- command builders (return thunks so a race can start them together) ---------------------
const transferT = (sender, receiver, microAmount, inputs) => async () => {
  const t = { sender, receiver, amount: amt(microAmount), instrumentId: { admin, id: "YAP" }, requestedAt: iso(-30_000), executeBefore: iso(3_600_000), inputHoldingCids: inputs.map((h) => h.contractId), meta: { values: {} } };
  const f = await post("/registry/transfer-instruction/v1/transfer-factory", { choiceArguments: { expectedAdmin: admin, transfer: t } });
  return submit(token, { actAs: [sender], label: "race-t", disclosedContracts: f.choiceContext.disclosedContracts,
    commands: [{ ExerciseCommand: { templateId: IF_TF, contractId: f.factoryId, choice: "TransferFactory_Transfer",
      choiceArgument: { expectedAdmin: admin, transfer: t, extraArgs: { context: f.choiceContext.choiceContextData, meta: { values: {} } } } } }] });
};
const allocateT = (sender, receiver, microAmount, inputs, ref) => async () => {
  const spec = { settlement: { executor: admin, settlementRef: { id: ref, cid: null }, requestedAt: iso(-30_000), allocateBefore: iso(3_600_000), settleBefore: iso(7_200_000), meta: { values: {} } },
    transferLegId: "leg-1", transferLeg: { sender, receiver, amount: amt(microAmount), instrumentId: { admin, id: "YAP" }, meta: { values: {} } } };
  const args = { expectedAdmin: admin, allocation: spec, requestedAt: iso(-30_000), inputHoldingCids: inputs.map((h) => h.contractId) };
  const f = await post("/registry/allocation-instruction/v1/allocation-factory", { choiceArguments: args });
  return submit(token, { actAs: [sender], label: "race-a", disclosedContracts: f.choiceContext.disclosedContracts,
    commands: [{ ExerciseCommand: { templateId: IF_AF, contractId: f.factoryId, choice: "AllocationFactory_Allocate",
      choiceArgument: { ...args, extraArgs: { context: f.choiceContext.choiceContextData, meta: { values: {} } } } } }] });
};
const tiT = (actAs, cid, choice) => () => submit(token, { actAs: [actAs], label: "race-ti", commands: [{ ExerciseCommand: { templateId: IF_TI, contractId: cid, choice, choiceArgument: extra } }] });
const alT = (actAs, cid, choice) => () => submit(token, { actAs, label: "race-al", commands: [{ ExerciseCommand: { templateId: IF_A, contractId: cid, choice, choiceArgument: extra } }] });
const tplT = (actAs, templateId, cid, choice, args) => () => submit(token, { actAs, label: "race-x", commands: [{ ExerciseCommand: { templateId, contractId: cid, choice, choiceArgument: args } }] });

// ---- harness -----------------------------------------------------------------------------------
let pass = 0, fail = 0, expected = 0;
const ok = (n, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  — " + x : ""}`); };
const reason = (e) => { const m = String(e?.message ?? e).replace(/\s+/g, " "); return (m.match(/CONTRACT_NOT_FOUND|LOCAL_VERDICT_[A-Z_]+|INACTIVE[A-Z_]*|LOCKED[A-Z_]*|ABORTED|DUPLICATE_COMMAND|ALREADY_EXISTS|DAML_FAILURE|fetch failed/) ?? [m.slice(-70)])[0]; };

async function race(name, thunks, expectOk = 1) {
  const res = await Promise.allSettled(thunks.map((t) => t()));
  const okN = res.filter((r) => r.status === "fulfilled").length;
  const why = [...new Set(res.filter((r) => r.status === "rejected").map((r) => reason(r.reason)))];
  const net = why.includes("fetch failed");
  ok(name, okN === expectOk && !net, `${okN}/${thunks.length} accepted${why.length ? `; rejected as ${why.join(", ")}` : ""}${net ? " (network error: inconclusive)" : ""}`);
}
async function invariants(label) {
  const S = await snap(); const v = checkInvariants(S, expected);
  ok(`invariants after ${label}`, v.length === 0, v.join("; "));
  return S;
}
async function settleAll() {   // withdraw every pending instruction / allocation so scenarios start clean
  const S = await snap();
  await Promise.allSettled([
    ...S.I.map((i) => tiT(i.createArgument.transfer.sender, i.contractId, "TransferInstruction_Withdraw")()),
    ...S.A.map((a) => alT([a.createArgument.allocation.transferLeg.sender], a.contractId, "Allocation_Withdraw")()),
  ]);
}
async function ensureNoPreapproval() {
  const pre = (await acs(token, admin, T.PRE)).filter((c) => c.createArgument.receiver === BOB);
  for (const c of pre) await tplT([BOB], T.PRE, c.contractId, "YapTransferPreapproval_Cancel", {})();
}
/** make sure `p` has at least n free holdings of >= minMu each, by splitting the biggest one */
async function ensureHoldings(p, n, minMu) {
  for (let guard = 0; guard < n + 3; guard++) {
    const hs = free(await snap(), p).filter((h) => mu(h.createArgument.amount) >= minMu);
    if (hs.length >= n) return hs.slice(0, n);
    const big = free(await snap(), p)[0];
    if (!big || mu(big.createArgument.amount) < 2 * minMu) throw new Error(`${p} lacks funds for ${n} holdings of ${minMu}`);
    await tplT([p], T.HOLDING, big.contractId, "YapHolding_Split", { splitAmount: amt(Math.floor(mu(big.createArgument.amount) / 2)) })();
  }
  throw new Error("ensureHoldings did not converge");
}

// ---- run ---------------------------------------------------------------------------------------
await ensureNoPreapproval(); await settleAll();
let S = await snap(); expected = supply(S);
const v0 = checkInvariants(S, expected); if (v0.length) { console.log("pre-existing violations: " + v0.join("; ")); process.exit(2); }
console.log(`start: supply ${expected / 1e6}, alice ${free(S, ALICE).length} holdings, bob ${free(S, BOB).length}\n`);

// A / B: several transfers all spending the same holding
{ const [H] = await ensureHoldings(ALICE, 1, 1000);
  await race("A  2 concurrent transfers of one holding", [transferT(ALICE, BOB, 100, [H]), transferT(ALICE, BOB, 100, [H])]);
  await invariants("A"); await settleAll(); }
{ const [H] = await ensureHoldings(ALICE, 1, 1000);
  await race("B  6 concurrent transfers of one holding", Array.from({ length: 6 }, () => transferT(ALICE, BOB, 100, [H])));
  await invariants("B"); await settleAll(); }

// C: a transfer and an allocation fight for the same holding
{ const [H] = await ensureHoldings(ALICE, 1, 1000);
  await race("C  transfer vs allocate on one holding", [transferT(ALICE, BOB, 100, [H]), allocateT(ALICE, BOB, 100, [H], `race-c-${Date.now()}`)]);
  await invariants("C"); await settleAll(); }

// D: three different actors resolve the same pending instruction (+ the same actor twice)
{ await ensureNoPreapproval(); const [H] = await ensureHoldings(ALICE, 1, 1000);
  await transferT(ALICE, BOB, 100, [H])();
  let I = (await snap()).I.find((i) => i.createArgument.transfer.sender === ALICE && i.createArgument.transfer.receiver === BOB);
  await race("D1 accept vs reject vs withdraw one instruction", [tiT(BOB, I.contractId, "TransferInstruction_Accept"), tiT(BOB, I.contractId, "TransferInstruction_Reject"), tiT(ALICE, I.contractId, "TransferInstruction_Withdraw")]);
  await invariants("D1");
  const [H2] = await ensureHoldings(ALICE, 1, 1000); await transferT(ALICE, BOB, 100, [H2])();
  I = (await snap()).I.find((i) => i.createArgument.transfer.sender === ALICE && i.createArgument.transfer.receiver === BOB);
  await race("D2 accept twice (same actor, same instruction)", [tiT(BOB, I.contractId, "TransferInstruction_Accept"), tiT(BOB, I.contractId, "TransferInstruction_Accept")]);
  await invariants("D2"); await settleAll(); }

// E: execute / withdraw / cancel the same allocation
{ const [H] = await ensureHoldings(ALICE, 1, 1000);
  await allocateT(ALICE, BOB, 100, [H], `race-e-${Date.now()}`)();
  const A = (await snap()).A[0];
  await race("E  execute vs withdraw vs cancel one allocation", [alT([admin, ALICE, BOB], A.contractId, "Allocation_ExecuteTransfer"), alT([ALICE], A.contractId, "Allocation_Withdraw"), alT([admin, ALICE, BOB], A.contractId, "Allocation_Cancel")]);
  await invariants("E"); await settleAll(); }

// F: split vs transfer on one holding; two merges that share a holding
{ const [H] = await ensureHoldings(ALICE, 1, 1000);
  await race("F1 split vs transfer on one holding", [tplT([ALICE], T.HOLDING, H.contractId, "YapHolding_Split", { splitAmount: amt(100) }), transferT(ALICE, BOB, 100, [H])]);
  await invariants("F1"); await settleAll();
  const [h1, h2, h3] = await ensureHoldings(ALICE, 3, 1000);
  await race("F2 two merges sharing a holding", [tplT([ALICE], T.HOLDING, h1.contractId, "YapHolding_Merge", { otherCids: [h2.contractId] }), tplT([ALICE], T.HOLDING, h3.contractId, "YapHolding_Merge", { otherCids: [h2.contractId] })]);
  await invariants("F2"); await settleAll(); }

// G: deduplication - the same commandId twice must not apply twice (mint has no inputs, so only dedup can stop it)
{ const before = supply(await snap()); const cid = `dedup-${Date.now()}`;
  const [adm] = await acs(token, admin, T.ADMIN);
  const mint = () => submit(token, { actAs: [admin], label: "dedup", commandId: cid, commands: [{ ExerciseCommand: { templateId: T.ADMIN, contractId: adm.contractId, choice: "YapAdmin_Mint", choiceArgument: { recipient: BOB, amount: amt(1) } } }] });
  const res = await Promise.allSettled([mint(), mint()]);
  const delta = supply(await snap()) - before;
  ok("G  same commandId twice applies once", delta === 1, `supply +${delta} micro; outcomes ${res.map((r) => r.status === "fulfilled" ? "ok" : reason(r.reason)).join(" / ")}`);
  expected += delta;                                   // account for whatever was actually minted
  const tiny = free(await snap(), BOB).find((h) => mu(h.createArgument.amount) === 1);
  if (tiny) { await tplT([BOB], T.HOLDING, tiny.contractId, "YapHolding_Burn", {})(); expected -= 1; }
  await invariants("G"); }

// H: independent holdings must NOT interfere: all succeed, and all can be withdrawn at once
{ await ensureNoPreapproval(); const hs = await ensureHoldings(ALICE, 5, 1000);
  await race("H1 5 independent transfers (distinct holdings)", hs.map((h) => transferT(ALICE, BOB, 100, [h])), 5);
  const pend = (await snap()).I.filter((i) => i.createArgument.transfer.sender === ALICE);
  await race("H2 5 independent withdraws", pend.slice(0, 5).map((i) => tiT(ALICE, i.contractId, "TransferInstruction_Withdraw")), Math.min(5, pend.length));
  await invariants("H"); await settleAll(); }

S = await invariants("everything");
console.log(`\nend: supply ${supply(S) / 1e6}, pending ${S.I.length}, allocations ${S.A.length}`);
console.log(`${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
