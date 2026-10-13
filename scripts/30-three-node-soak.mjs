// Randomised soak across THREE participants with a conservation check after EVERY operation.
//   alice @ our node (asc-val-1) | carol @ MZF | dave @ cryptolampung | executor/issuer admin @ our node
//   node scripts/30-three-node-soak.mjs [ops=60] [seed]       needs .env.testnet, .env.mzf, .env.cl and cusdt-token 0.4.1 on all three
// Every actor acts ONLY on its own node. Invariants (scripts/invariants.mjs, read as admin) are checked after each operation:
// total supply constant, locked == allocation legs, one allocation per locked holding, no zero/over-precise holdings.
// Own traffic meter (paidTrafficCost); aborts past BUDGET (default 300000 bytes in total). After a 503 / fetch failed the ledger is re-read,
// never the exception trusted. Dave (smallest node) acts in ~15 % of the operations.
import { loadEnv } from "./lib.mjs";
import { T, snapshot, supply, checkInvariants, mu, sumMu } from "./invariants.mjs";
import { amt, IF } from "./ops.mjs";
import { node, sleep } from "./nodes.mjs";

const OPS = Number(process.argv[2] ?? 60), SEED = Number(process.argv[3] ?? (Date.now() % 1e9)), BUDGET = Number(process.env.BUDGET ?? 300_000);
const OURS = loadEnv(".env.testnet"), MZF = loadEnv(".env.mzf"), CL = loadEnv(".env.cl");
if ([OURS, MZF, CL].some((e) => e.INSECURE_TLS === "1")) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const admin = OURS.CUSDT_ADMIN_PARTY, sfx = admin.split("::")[1], ALICE = `cusdt-alice::${sfx}`, CAROL = MZF.CUSDT_MZF_CAROL, DAVE = CL.CUSDT_CL_DAVE;
const REGISTRY = process.env.CUSDT_REGISTRY_URL || "https://registry-testnet.airdropasc.com";
const HOLD = "#cusdt-token:CusdtToken:CusdtHolding";
const ours = node(OURS, "ours"), mzf = node(MZF, "mzf"), cl = node(CL, "cl");
const NODE = { [ALICE]: ours, [CAROL]: mzf, [DAVE]: cl }, NAME = { [ALICE]: "alice", [CAROL]: "carol", [DAVE]: "dave" };
const ACTORS = [ALICE, ALICE, ALICE, CAROL, CAROL, DAVE];            // 50 / 33 / 17 %
const short = (e) => String(e?.message ?? e).replace(/\s+/g, " ");
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const extra = { extraArgs: { context: { values: {} }, meta: { values: {} } } };
let _s = SEED >>> 0;
const rnd = () => { _s |= 0; _s = (_s + 0x6D2B79F5) | 0; let t = Math.imul(_s ^ (_s >>> 15), 1 | _s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const ri = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const pick = (a) => a[Math.floor(rnd() * a.length)];
const shuffle = (a) => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };

let bytes = 0, txs = 0;
const metered = async (nd, actAs, commands, disclosed = []) => {
  const r = await nd.tx(actAs, commands, disclosed);
  bytes += Number(r?.transaction?.paidTrafficCost ?? 0); txs++;
  if (bytes > BUDGET) throw Object.assign(new Error(`BUDGET exceeded (${bytes} > ${BUDGET})`), { budget: true });
  return r;
};
const post = (path, body) => fetch(`${REGISTRY}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const free = (S, p) => S.H.filter((h) => h.createArgument.owner === p && h.createArgument.lock == null);
const inputsFor = (S, p, need) => { let acc = 0; const out = []; for (const h of shuffle(free(S, p))) { out.push(h); acc += mu(h.createArgument.amount); if (acc >= need) return out; } return null; };

async function offer(sender, receiver, micro, inputs) {
  const tr = { sender, receiver, amount: amt(micro), instrumentId: { admin, id: "cUSDT" }, requestedAt: iso(-30_000), executeBefore: iso(3_600_000), inputHoldingCids: inputs.map((h) => h.contractId), meta: { values: {} } };
  const f = await post("/registry/transfer-instruction/v1/transfer-factory", { choiceArguments: { expectedAdmin: admin, transfer: tr } });
  return metered(NODE[sender], [sender], [{ ExerciseCommand: { templateId: IF.TF, contractId: f.factoryId, choice: "TransferFactory_Transfer", choiceArgument: { expectedAdmin: admin, transfer: tr, extraArgs: { context: f.choiceContext.choiceContextData, meta: { values: {} } } } } }], f.choiceContext.disclosedContracts);
}
async function allocate(sender, receiver, micro, inputs, ref) {
  const spec = { settlement: { executor: admin, settlementRef: { id: ref, cid: null }, requestedAt: iso(-30_000), allocateBefore: iso(3_600_000), settleBefore: iso(7_200_000), meta: { values: {} } },
    transferLegId: "leg-1", transferLeg: { sender, receiver, amount: amt(micro), instrumentId: { admin, id: "cUSDT" }, meta: { values: {} } } };
  const args = { expectedAdmin: admin, allocation: spec, requestedAt: iso(-30_000), inputHoldingCids: inputs.map((h) => h.contractId) };
  const f = await post("/registry/allocation-instruction/v1/allocation-factory", { choiceArguments: args });
  return metered(NODE[sender], [sender], [{ ExerciseCommand: { templateId: IF.AF, contractId: f.factoryId, choice: "AllocationFactory_Allocate", choiceArgument: { ...args, extraArgs: { context: f.choiceContext.choiceContextData, meta: { values: {} } } } } }], f.choiceContext.disclosedContracts);
}
const exTI = (actor, cid, choice) => metered(NODE[actor], [actor], [{ ExerciseCommand: { templateId: IF.TI, contractId: cid, choice, choiceArgument: extra } }]);
const exA = (actor, cid, choice) => metered(NODE[actor], [actor], [{ ExerciseCommand: { templateId: IF.A, contractId: cid, choice, choiceArgument: extra } }]);
const known = (c) => [ALICE, CAROL, DAVE].includes(c);
let counter = 0;

const OPSET = {
  async transfer(S, a) { const bal = sumMu(free(S, a)); if (bal < 2) return "skip"; const to = pick([ALICE, CAROL, DAVE].filter((p) => p !== a));
    const m = ri(1, Math.min(bal, 3)); await offer(a, to, m, inputsFor(S, a, m)); },
  async self_transfer(S, a) { const bal = sumMu(free(S, a)); if (bal < 2) return "skip"; await offer(a, a, 1, inputsFor(S, a, 1)); },
  async accept(S, a) { const i = pick(S.I.filter((c) => c.createArgument.transfer.receiver === a)); if (!i) return "skip"; await exTI(a, i.contractId, "TransferInstruction_Accept"); },
  async reject(S, a) { const i = pick(S.I.filter((c) => c.createArgument.transfer.receiver === a)); if (!i) return "skip"; await exTI(a, i.contractId, "TransferInstruction_Reject"); },
  async withdraw(S, a) { const i = pick(S.I.filter((c) => c.createArgument.transfer.sender === a)); if (!i) return "skip"; await exTI(a, i.contractId, "TransferInstruction_Withdraw"); },
  async allocate(S, a) { const bal = sumMu(free(S, a)); if (bal < 2) return "skip"; const to = pick([ALICE, CAROL, DAVE].filter((p) => p !== a));
    const m = ri(1, Math.min(bal, 2)); await allocate(a, to, m, inputsFor(S, a, m), `soak3-${SEED}-${counter++}`); },
  async withdraw_alloc(S, a) { const x = pick(S.A.filter((c) => c.createArgument.allocation.transferLeg.sender === a)); if (!x) return "skip"; await exA(a, x.contractId, "Allocation_Withdraw"); },
  async merge(S, a) { const hs = free(S, a); if (hs.length < 3) return "skip"; const some = shuffle(hs).slice(0, Math.min(hs.length, 4));
    await metered(NODE[a], [a], [{ ExerciseCommand: { templateId: HOLD, contractId: some[0].contractId, choice: "CusdtHolding_Merge", choiceArgument: { otherCids: some.slice(1).map((h) => h.contractId) } } }]); },
  async split(S, a) { const h = pick(free(S, a).filter((x) => mu(x.createArgument.amount) >= 2)); if (!h) return "skip";
    await metered(NODE[a], [a], [{ ExerciseCommand: { templateId: HOLD, contractId: h.contractId, choice: "CusdtHolding_Split", choiceArgument: { splitAmount: amt(ri(1, mu(h.createArgument.amount) - 1)) } } }]); },
  // ---- must-fail (rejected before anything is sent: no ledger change) ----
  async bad_wrong_actor(S, a) { const i = pick(S.I.filter((c) => c.createArgument.transfer.sender === a)); if (!i) return "skip";
    return { mustFail: () => exTI(a, i.contractId, "TransferInstruction_Accept") }; },                 // the sender cannot accept
  async bad_foreign_withdraw(S, a) { const x = pick(S.A.filter((c) => c.createArgument.allocation.transferLeg.sender !== a)); if (!x) return "skip";
    return { mustFail: () => exA(a, x.contractId, "Allocation_Withdraw") }; },                          // not my allocation (often on another node)
  async bad_overspend(S, a) { const bal = sumMu(free(S, a)); const ins = inputsFor(S, a, bal); if (!ins || bal < 1) return "skip";
    return { mustFail: () => offer(a, pick([ALICE, CAROL, DAVE].filter((p) => p !== a)), bal + 1, ins) }; },
  async bad_spend_foreign_holding(S, a) { const other = pick([ALICE, CAROL, DAVE].filter((p) => p !== a)); const h = free(S, other)[0]; if (!h) return "skip";
    return { mustFail: () => offer(a, other, 1, [h]) }; },                                              // someone else's holding as input
};
const WEIGHTS = { transfer: 9, self_transfer: 1, accept: 6, reject: 2, withdraw: 2, allocate: 4, withdraw_alloc: 3, merge: 2, split: 2, bad_wrong_actor: 1, bad_foreign_withdraw: 1, bad_overspend: 1, bad_spend_foreign_holding: 1 };
const bag = Object.entries(WEIGHTS).flatMap(([k, w]) => Array(w).fill(k));

// ---- run ------------------------------------------------------------------------------------------
const stats = {}; const bump = (k, f) => { (stats[k] ??= { ok: 0, fail: 0, skip: 0, mustFailOk: 0 })[f]++; };
const snapNow = async () => snapshot(await ours.token(), admin);
let S = await snapNow();
const expected = supply(S);
console.log(`seed ${SEED}, ${OPS} ops, budget ${BUDGET} bytes. start: ${S.H.length} holdings, ${S.I.length} pending, ${S.A.length} allocations, supply ${expected / 1e6}`);
const pre = checkInvariants(S, expected); if (pre.length) { console.log("PRE-EXISTING violations:\n  " + pre.join("\n  ")); process.exit(2); }

// fund carol and dave from alice so everybody can act (offers accepted on their own nodes)
for (const [p, want] of [[CAROL, 14], [DAVE, 8]]) {
  const have = sumMu(free(S, p)); if (have >= want) continue;
  S = await snapNow(); const need = want - have; await offer(ALICE, p, need, inputsFor(S, ALICE, need));
  let i = null; for (let k = 0; k < 20 && !i; k++) { await sleep(2000); i = (await NODE[p].acs(p, T.INSTR)).find((x) => x.createArgument.transfer.sender === ALICE); }
  if (i) await exTI(p, i.contractId, "TransferInstruction_Accept");
}
S = await snapNow();
console.log(`funded: alice ${sumMu(free(S, ALICE))} | carol ${sumMu(free(S, CAROL))} | dave ${sumMu(free(S, DAVE))} micro`);

const log = []; let broken = false, unexpected = 0;
for (let n = 1; n <= OPS && !broken; n++) {
  const name = pick(bag), actor = pick(ACTORS);
  let res;
  try { res = await OPSET[name](S, actor); }
  catch (e) {
    if (e.budget) { console.log(`  stopping: ${e.message}`); break; }
    const m = short(e); bump(name, "fail"); unexpected++; log.push(`${n} ${NAME[actor]} ${name} FAIL`);
    console.log(`  ! op ${n} ${NAME[actor]}:${name} failed: ${m.slice(-170)}`); res = "failed"; await sleep(4000);
  }
  if (res === "skip") { bump(name, "skip"); continue; }
  if (res && typeof res === "object" && res.mustFail) {
    try { await res.mustFail(); unexpected++; bump(name, "fail"); console.log(`  ! op ${n} ${NAME[actor]}:${name} SUCCEEDED but must fail`); }
    catch (e) { if (e.budget) { console.log("  stopping: " + e.message); break; } bump(name, "mustFailOk"); log.push(`${n} ${NAME[actor]} ${name} rejected`); }
  } else if (res !== "failed") { bump(name, "ok"); log.push(`${n} ${NAME[actor]} ${name} ok`); }
  await sleep(1500);                                                        // let the other nodes catch up before the next read
  S = await snapNow(); const v = checkInvariants(S, expected);
  if (v.length) {   // a cross-node lag can look like a violation for a moment: re-read once before declaring one
    await sleep(8000); S = await snapNow(); const v2 = checkInvariants(S, expected);
    if (v2.length) { broken = true; console.log(`\nINVARIANT VIOLATED after op ${n} (${NAME[actor]}:${name}):\n  ${v2.join("\n  ")}\nlast ops: ${log.slice(-8).join(" | ")}\nreplay: node scripts/30-three-node-soak.mjs ${OPS} ${SEED}`); }
    else console.log(`  (op ${n}: transient violation cleared after a re-read — cross-node lag)`);
  }
  if (!broken && n % 10 === 0) console.log(`  op ${n}/${OPS} ok  (holdings ${S.H.length}, pending ${S.I.length}, allocations ${S.A.length}, traffic ${bytes} B)`);
}

// ---- cleanup: everybody withdraws their own pending offers/allocations; carol hands her funds back --------------
if (!broken) {
  try {
    for (const i of S.I) if (known(i.createArgument.transfer.sender)) await exTI(i.createArgument.transfer.sender, i.contractId, "TransferInstruction_Withdraw").catch(() => {});
    for (const a of S.A) if (known(a.createArgument.allocation.transferLeg.sender)) await exA(a.createArgument.allocation.transferLeg.sender, a.contractId, "Allocation_Withdraw").catch(() => {});
    await sleep(6000); S = await snapNow();
    const hs = free(S, CAROL), tot = sumMu(hs);
    if (tot > 0) { await offer(CAROL, ALICE, tot, hs); let i = null; for (let k = 0; k < 20 && !i; k++) { await sleep(2000); i = (await ours.acs(ALICE, T.INSTR)).find((x) => x.createArgument.transfer.sender === CAROL); } if (i) await exTI(ALICE, i.contractId, "TransferInstruction_Accept"); }
  } catch (e) { console.log("cleanup issue: " + short(e).slice(-160)); }
  S = await snapNow(); const v = checkInvariants(S, expected);
  if (v.length) { broken = true; console.log("INVARIANT VIOLATED after cleanup:\n  " + v.join("\n  ")); }
  console.log(`cleanup: ${S.I.length} pending, ${S.A.length} allocations left; alice ${sumMu(free(S, ALICE))} carol ${sumMu(free(S, CAROL))} dave ${sumMu(free(S, DAVE))} micro`);
}
console.log("\nop                          ok  mustFail-rejected  failed  skipped");
for (const [k, s] of Object.entries(stats).sort()) console.log(`${k.padEnd(26)} ${String(s.ok).padStart(3)}  ${String(s.mustFailOk).padStart(17)}  ${String(s.fail).padStart(6)}  ${String(s.skip).padStart(7)}`);
const total = Object.values(stats).reduce((a, s) => a + s.ok + s.mustFailOk, 0);
console.log(`\ntraffic metered: ${bytes} bytes in ${txs} txs`);
console.log(`${broken ? "FAIL" : "PASS"}: ${total} operations applied across 3 nodes, invariants ${broken ? "BROKEN" : "held after every one"}, ${unexpected} unexpected failure(s). seed ${SEED}`);
process.exitCode = broken || unexpected ? 1 : 0;
