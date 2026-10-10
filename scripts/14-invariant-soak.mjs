// Randomised soak test with a conservation check after EVERY operation (testnet, internal parties).
//   node scripts/14-invariant-soak.mjs [ops=60] [seed]        (CUSDT_REGISTRY_URL must point at the registry)
// Invariants, read as the admin (signatory of every holding / instruction / allocation):
//   I1  sum(all holdings, locked included) + sum(pending transfer instructions) == expected supply
//   I2  locked amount == sum of active allocation legs
//   I3  every allocation points at an existing locked holding of exactly its leg amount
//   I4  every locked holding is referenced by exactly one allocation
//   I5  every holding is > 0 and has <= 6 decimals
// "Must-fail" operations (overspend, wrong party, 7 decimals) must be rejected and change nothing.
import { getToken, ledger, ledgerEnd, submit, need, PKG } from "./lib.mjs";

const OPS = Number(process.argv[2] ?? 60);
const SEED = Number(process.argv[3] ?? (Date.now() % 1e9));
const admin = need("CUSDT_ADMIN_PARTY");
const suffix = admin.split("::")[1];
const ALICE = `cusdt-alice::${suffix}`, BOB = `cusdt-bob::${suffix}`;
const registry = process.env.CUSDT_REGISTRY_URL || "http://localhost:8787";
const token = await getToken();

const HOLDING = `${PKG}:CusdtToken:CusdtHolding`, INSTR = `${PKG}:CusdtToken:CusdtTransferInstruction`;
const ALLOC = `${PKG}:CusdtToken:CusdtAllocation`, ADMINT = `${PKG}:CusdtToken:CusdtAdmin`, PRE = `${PKG}:CusdtToken:CusdtTransferPreapproval`;
const IF_TF = "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory";
const IF_TI = "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction";
const IF_AF = "#splice-api-token-allocation-instruction-v1:Splice.Api.Token.AllocationInstructionV1:AllocationFactory";
const IF_A = "#splice-api-token-allocation-v1:Splice.Api.Token.AllocationV1:Allocation";
const extra = { extraArgs: { context: { values: {} }, meta: { values: {} } } };
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const mu = (s) => Math.round(Number(s) * 1e6);                 // micro-units: exact integer arithmetic
const amt = (m) => (m / 1e6).toFixed(10);

// seeded PRNG (mulberry32) so a failing run can be replayed
let _s = SEED >>> 0;
const rnd = () => { _s |= 0; _s = (_s + 0x6D2B79F5) | 0; let t = Math.imul(_s ^ (_s >>> 15), 1 | _s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const ri = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const pick = (a) => a[Math.floor(rnd() * a.length)];
const shuffle = (a) => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };

// ---- state -----------------------------------------------------------------------------------
// Reads are safe to retry; writes are not (a timed-out write may still have committed), the invariant check covers those.
async function retry(fn, tries = 5) {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) { if (i >= tries || !isNet(String(e.message) + String(e.cause?.code ?? ""))) throw e; await new Promise((r) => setTimeout(r, 3000 * i)); }
  }
}
const snap = () => retry(snapOnce);
async function snapOnce() {
  const off = await ledgerEnd(token);
  const q = async (tpl) => {
    const r = await ledger(token, "/v2/state/active-contracts", { method: "POST", json: { activeAtOffset: off,
      eventFormat: { filtersByParty: { [admin]: { cumulative: [{ identifierFilter: { TemplateFilter: { value: { templateId: tpl, includeCreatedEventBlob: false } } } }] } }, verbose: true } } });
    return (Array.isArray(r) ? r : (r.activeContracts ?? [])).map((it) => it.contractEntry?.JsActiveContract?.createdEvent).filter(Boolean);
  };
  const [H, I, A] = await Promise.all([q(HOLDING), q(INSTR), q(ALLOC)]);
  return { H, I, A };
}
const free = (S, p) => S.H.filter((h) => h.createArgument.owner === p && h.createArgument.lock == null);
const sumMu = (cs, f = (c) => c.createArgument.amount) => cs.reduce((s, c) => s + mu(f(c)), 0);
const internal = (...ps) => ps.every((p) => p === ALICE || p === BOB);

let expected = 0;
function violations(S) {
  const v = [];
  const sumH = sumMu(S.H), sumI = sumMu(S.I, (c) => c.createArgument.transfer.amount);
  if (sumH + sumI !== expected) v.push(`I1 supply: holdings ${sumH} + pending ${sumI} = ${sumH + sumI} != expected ${expected} (micro)`);
  const locked = S.H.filter((h) => h.createArgument.lock != null);
  const allocSum = sumMu(S.A, (c) => c.createArgument.allocation.transferLeg.amount);
  if (sumMu(locked) !== allocSum) v.push(`I2 locked ${sumMu(locked)} != allocations ${allocSum}`);
  const byCid = new Map(S.H.map((h) => [h.contractId, h]));
  const refs = new Map();
  for (const a of S.A) {
    const h = byCid.get(a.createArgument.lockedCid);
    if (!h) v.push(`I3 allocation ${a.contractId.slice(0, 10)} has no holding`);
    else if (h.createArgument.lock == null || mu(h.createArgument.amount) !== mu(a.createArgument.allocation.transferLeg.amount)) v.push(`I3 allocation ${a.contractId.slice(0, 10)} holding mismatch`);
    refs.set(a.createArgument.lockedCid, (refs.get(a.createArgument.lockedCid) ?? 0) + 1);
  }
  for (const h of locked) if ((refs.get(h.contractId) ?? 0) !== 1) v.push(`I4 locked holding ${h.contractId.slice(0, 10)} referenced ${refs.get(h.contractId) ?? 0}x`);
  for (const h of S.H) { const x = Number(h.createArgument.amount); if (!(x > 0) || Math.abs(x * 1e6 - Math.round(x * 1e6)) > 1e-6) v.push(`I5 bad amount ${h.createArgument.amount}`); }
  return v;
}

// ---- building blocks -------------------------------------------------------------------------
const post = (path, body) => retry(async () => { const r = await fetch(`${registry}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); if (!r.ok) throw new Error(`registry ${r.status}`); return r.json(); });
function inputsFor(S, p, needMu) { let acc = 0; const out = []; for (const h of shuffle(free(S, p))) { out.push(h); acc += mu(h.createArgument.amount); if (acc >= needMu) return out; } return null; }
async function transfer(sender, receiver, amount, inputs) {
  const t = { sender, receiver, amount, instrumentId: { admin, id: "cUSDT" }, requestedAt: iso(-30_000), executeBefore: iso(3_600_000), inputHoldingCids: inputs.map((h) => h.contractId), meta: { values: {} } };
  const f = await post("/registry/transfer-instruction/v1/transfer-factory", { choiceArguments: { expectedAdmin: admin, transfer: t } });
  await submit(token, { actAs: [sender], label: "soak-t", disclosedContracts: f.choiceContext.disclosedContracts,
    commands: [{ ExerciseCommand: { templateId: IF_TF, contractId: f.factoryId, choice: "TransferFactory_Transfer",
      choiceArgument: { expectedAdmin: admin, transfer: t, extraArgs: { context: f.choiceContext.choiceContextData, meta: { values: {} } } } } }] });
}
async function allocate(sender, receiver, amount, inputs, ref) {
  const spec = { settlement: { executor: admin, settlementRef: { id: ref, cid: null }, requestedAt: iso(-30_000), allocateBefore: iso(3_600_000), settleBefore: iso(7_200_000), meta: { values: {} } },
    transferLegId: "leg-1", transferLeg: { sender, receiver, amount, instrumentId: { admin, id: "cUSDT" }, meta: { values: {} } } };
  const args = { expectedAdmin: admin, allocation: spec, requestedAt: iso(-30_000), inputHoldingCids: inputs.map((h) => h.contractId) };
  const f = await post("/registry/allocation-instruction/v1/allocation-factory", { choiceArguments: args });
  await submit(token, { actAs: [sender], label: "soak-a", disclosedContracts: f.choiceContext.disclosedContracts,
    commands: [{ ExerciseCommand: { templateId: IF_AF, contractId: f.factoryId, choice: "AllocationFactory_Allocate",
      choiceArgument: { ...args, extraArgs: { context: f.choiceContext.choiceContextData, meta: { values: {} } } } } }] });
}
const exTI = (actAs, cid, choice) => submit(token, { actAs: [actAs], label: "soak-ti", commands: [{ ExerciseCommand: { templateId: IF_TI, contractId: cid, choice, choiceArgument: extra } }] });
const exA = (actAs, cid, choice) => submit(token, { actAs, label: "soak-al", commands: [{ ExerciseCommand: { templateId: IF_A, contractId: cid, choice, choiceArgument: extra } }] });
const exT = (actAs, templateId, cid, choice, args) => submit(token, { actAs, label: "soak-x", commands: [{ ExerciseCommand: { templateId, contractId: cid, choice, choiceArgument: args } }] });

// ---- operations: each returns "skip" when not applicable in the current state ----------------
let counter = 0;
const OPSET = {
  async transfer(S) { const p = pick([ALICE, BOB]); const bal = sumMu(free(S, p)); if (bal < 2) return "skip";
    const a = ri(1, Math.min(bal, 3_000_000)); const r = rnd() < 0.1 ? p : (p === ALICE ? BOB : ALICE); await transfer(p, r, amt(a), inputsFor(S, p, a)); },
  async accept(S) { const i = pick(S.I.filter((c) => internal(c.createArgument.transfer.sender, c.createArgument.transfer.receiver))); if (!i) return "skip"; await exTI(i.createArgument.transfer.receiver, i.contractId, "TransferInstruction_Accept"); },
  async reject(S) { const i = pick(S.I.filter((c) => internal(c.createArgument.transfer.sender, c.createArgument.transfer.receiver))); if (!i) return "skip"; await exTI(i.createArgument.transfer.receiver, i.contractId, "TransferInstruction_Reject"); },
  async withdraw(S) { const i = pick(S.I.filter((c) => internal(c.createArgument.transfer.sender, c.createArgument.transfer.receiver))); if (!i) return "skip"; await exTI(i.createArgument.transfer.sender, i.contractId, "TransferInstruction_Withdraw"); },
  async allocate(S) { const p = pick([ALICE, BOB]); const bal = sumMu(free(S, p)); if (bal < 2) return "skip";
    const a = ri(1, Math.min(bal, 2_000_000)); await allocate(p, p === ALICE ? BOB : ALICE, amt(a), inputsFor(S, p, a), `soak-${SEED}-${counter++}`); },
  async exec_alloc(S) { const a = pick(S.A.filter((c) => c.createArgument.allocation.settlement.executor === admin && internal(c.createArgument.allocation.transferLeg.sender, c.createArgument.allocation.transferLeg.receiver))); if (!a) return "skip";
    const l = a.createArgument.allocation.transferLeg; await exA([admin, l.sender, l.receiver], a.contractId, "Allocation_ExecuteTransfer"); },
  async withdraw_alloc(S) { const a = pick(S.A.filter((c) => internal(c.createArgument.allocation.transferLeg.sender))); if (!a) return "skip"; await exA([a.createArgument.allocation.transferLeg.sender], a.contractId, "Allocation_Withdraw"); },
  async cancel_alloc(S) { const a = pick(S.A.filter((c) => c.createArgument.allocation.settlement.executor === admin && internal(c.createArgument.allocation.transferLeg.sender, c.createArgument.allocation.transferLeg.receiver))); if (!a) return "skip";
    const l = a.createArgument.allocation.transferLeg; await exA([admin, l.sender, l.receiver], a.contractId, "Allocation_Cancel"); },
  async merge(S) { const p = pick([ALICE, BOB]); const hs = free(S, p); if (hs.length < 2) return "skip"; await exT([p], HOLDING, hs[0].contractId, "CusdtHolding_Merge", { otherCids: hs.slice(1).map((h) => h.contractId) }); },
  async split(S) { const p = pick([ALICE, BOB]); const h = pick(free(S, p).filter((x) => mu(x.createArgument.amount) >= 2)); if (!h) return "skip";
    await exT([p], HOLDING, h.contractId, "CusdtHolding_Split", { splitAmount: amt(ri(1, mu(h.createArgument.amount) - 1)) }); },
  async mint_burn(S) { const p = pick([ALICE, BOB]); const [adm] = (await (async () => { const r = await ledger(token, "/v2/state/active-contracts", { method: "POST", json: { activeAtOffset: await ledgerEnd(token),
      eventFormat: { filtersByParty: { [admin]: { cumulative: [{ identifierFilter: { TemplateFilter: { value: { templateId: ADMINT, includeCreatedEventBlob: false } } } }] } }, verbose: true } } });
      return (Array.isArray(r) ? r : (r.activeContracts ?? [])).map((it) => it.contractEntry?.JsActiveContract?.createdEvent).filter(Boolean); })());
    await exT([admin], ADMINT, adm.contractId, "CusdtAdmin_Mint", { recipient: p, amount: amt(1) }); expected += 1;
    const S2 = await snap(); const tiny = free(S2, p).find((h) => mu(h.createArgument.amount) === 1);
    if (tiny) { await exT([p], HOLDING, tiny.contractId, "CusdtHolding_Burn", {}); expected -= 1; } },
  // bob opts in/out of direct transfers: while he has a preapproval the registry answers "direct"
  async toggle_pre(S) {
    const q = async (tpl) => { const r = await ledger(token, "/v2/state/active-contracts", { method: "POST", json: { activeAtOffset: await ledgerEnd(token),
      eventFormat: { filtersByParty: { [admin]: { cumulative: [{ identifierFilter: { TemplateFilter: { value: { templateId: tpl, includeCreatedEventBlob: false } } } }] } }, verbose: true } } });
      return (Array.isArray(r) ? r : (r.activeContracts ?? [])).map((it) => it.contractEntry?.JsActiveContract?.createdEvent).filter(Boolean); };
    const pre = (await retry(() => q(PRE))).filter((c) => c.createArgument.receiver === BOB);
    if (pre.length) { for (const c of pre) await exT([BOB], PRE, c.contractId, "CusdtTransferPreapproval_Cancel", {}); return; }
    const [adm] = await retry(() => q(ADMINT));
    await exT([admin], ADMINT, adm.contractId, "CusdtAdmin_CreatePreapproval", { receiver: BOB });
  },
  // ---- must-fail operations ----
  async bad_overspend(S) { const p = pick([ALICE, BOB]); const bal = sumMu(free(S, p)); const ins = inputsFor(S, p, bal); if (!ins) return "skip"; return { mustFail: () => transfer(p, p === ALICE ? BOB : ALICE, amt(bal + 1), ins) }; },
  async bad_precision(S) { const p = pick([ALICE, BOB]); const ins = inputsFor(S, p, 2); if (!ins) return "skip"; return { mustFail: () => transfer(p, p === ALICE ? BOB : ALICE, "0.0000001000", ins) }; },
  async bad_party(S) { const i = pick(S.I.filter((c) => internal(c.createArgument.transfer.sender, c.createArgument.transfer.receiver))); if (!i) return "skip";
    return { mustFail: () => exTI(i.createArgument.transfer.sender, i.contractId, "TransferInstruction_Accept") }; },   // sender cannot accept
};
const WEIGHTS = { transfer: 6, accept: 4, reject: 2, withdraw: 1, allocate: 3, exec_alloc: 2, withdraw_alloc: 1, cancel_alloc: 1, merge: 2, split: 2, mint_burn: 1, toggle_pre: 2, bad_overspend: 1, bad_precision: 2, bad_party: 1 };
const bag = Object.entries(WEIGHTS).flatMap(([k, w]) => Array(w).fill(k));

// ---- run -------------------------------------------------------------------------------------
const stats = {}; const bump = (k, f) => { (stats[k] ??= { ok: 0, fail: 0, skip: 0, mustFailOk: 0 })[f]++; };
const log = []; let unexpected = 0;
const isNet = (m) => /fetch failed|ECONN|ETIMEDOUT|UND_ERR|socket|timeout|502|503|504/i.test(m);

let S = await snap();
expected = sumMu(S.H) + sumMu(S.I, (c) => c.createArgument.transfer.amount);
console.log(`seed ${SEED}, ${OPS} ops. start: ${S.H.length} holdings, ${S.I.length} pending, ${S.A.length} allocations, supply ${expected / 1e6}`);
const v0 = violations(S); if (v0.length) { console.log("PRE-EXISTING violations before the run:\n  " + v0.join("\n  ")); process.exit(2); }

let broken = false;
for (let n = 1; n <= OPS && !broken; n++) {
  const name = pick(bag);
  let res;
  try { res = await OPSET[name](S); }
  catch (e) {
    const m = String(e.message).replace(/\s+/g, " ");
    bump(name, "fail"); if (!isNet(m)) { unexpected++; console.log(`  ! op ${n} ${name} failed unexpectedly: ${m.slice(0, 200)}`); } else console.log(`  ~ op ${n} ${name}: network error (state re-checked)`);
    log.push(`${n} ${name} FAIL`); res = "failed";
  }
  if (res === "skip") { bump(name, "skip"); log.push(`${n} ${name} skip`); continue; }
  if (res && typeof res === "object" && res.mustFail) {
    try { await res.mustFail(); unexpected++; bump(name, "fail"); console.log(`  ! op ${n} ${name} SUCCEEDED but must fail`); log.push(`${n} ${name} MUSTFAIL-BROKEN`); }
    catch (e) { bump(name, "mustFailOk"); log.push(`${n} ${name} rejected`); }
  } else if (res !== "failed") { bump(name, "ok"); log.push(`${n} ${name} ok`); }
  S = await snap();
  const v = violations(S);
  if (v.length) { broken = true; console.log(`\nINVARIANT VIOLATED after op ${n} (${name}):\n  ${v.join("\n  ")}\nlast ops: ${log.slice(-8).join(" | ")}\nreplay with: node scripts/14-invariant-soak.mjs ${OPS} ${SEED}`); }
  else if (n % 10 === 0) console.log(`  op ${n}/${OPS} ok  (holdings ${S.H.length}, pending ${S.I.length}, allocations ${S.A.length}, supply ${expected / 1e6})`);
}

// ---- cleanup: resolve everything pending, then final check ------------------------------------
if (!broken) {
  for (const i of S.I.filter((c) => internal(c.createArgument.transfer.sender, c.createArgument.transfer.receiver))) { try { await exTI(i.createArgument.transfer.sender, i.contractId, "TransferInstruction_Withdraw"); } catch { /* ignore */ } }
  for (const a of S.A.filter((c) => internal(c.createArgument.allocation.transferLeg.sender))) { try { await exA([a.createArgument.allocation.transferLeg.sender], a.contractId, "Allocation_Withdraw"); } catch { /* ignore */ } }
  S = await snap(); const v = violations(S);
  if (v.length) { broken = true; console.log("INVARIANT VIOLATED after cleanup:\n  " + v.join("\n  ")); }
  console.log(`cleanup: ${S.I.length} pending, ${S.A.length} allocations left; alice ${sumMu(free(S, ALICE)) / 1e6}, bob ${sumMu(free(S, BOB)) / 1e6}`);
}
console.log("\nop             ok  mustFail-rejected  failed  skipped");
for (const [k, s] of Object.entries(stats).sort()) console.log(`${k.padEnd(14)} ${String(s.ok).padStart(2)}  ${String(s.mustFailOk).padStart(17)}  ${String(s.fail).padStart(6)}  ${String(s.skip).padStart(7)}`);
const total = Object.values(stats).reduce((a, s) => a + s.ok + s.mustFailOk, 0);
console.log(`\n${broken ? "FAIL" : "PASS"}: ${total} operations applied, invariants ${broken ? "BROKEN" : "held after every one"}, ${unexpected} unexpected failure(s). seed ${SEED}`);
process.exitCode = broken || unexpected ? 1 : 0;
