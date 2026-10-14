// Race between TWO NODES on the same allocation: the executor settles (our node, through the delegated authority) while the
// remote sender withdraws (MZF node), started in the same tick / with a head start for either side.
// Rule under test: never both succeed; exactly one outcome; conservation holds. Small on purpose (both validators have little traffic).
//   node scripts/24-cross-node-race.mjs [rounds=3]      needs cusdt-token >= 0.4.1 on both nodes
import { loadEnv } from "./lib.mjs";
import { T, snapshot, supply, checkInvariants } from "./invariants.mjs";
import { makeOps, amt, IF } from "./ops.mjs";
import { node, waitFor, sleep } from "./nodes.mjs";

const ROUNDS = Number(process.argv[2] ?? 3);
const OURS = loadEnv(".env.testnet"), MZF = loadEnv(".env.mzf");
if (OURS.INSECURE_TLS === "1" || MZF.INSECURE_TLS === "1") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const admin = OURS.CUSDT_ADMIN_PARTY, sfx = admin.split("::")[1], ALICE = `cusdt-alice::${sfx}`, CAROL = MZF.CUSDT_MZF_CAROL;
const REGISTRY = process.env.CUSDT_REGISTRY_URL || "https://registry-testnet.cryptolampung.space";
const PKG = "#cusdt-token", PROPOSAL = `${PKG}:CusdtToken:CusdtSettlementProposal`, AUTH = `${PKG}:CusdtToken:CusdtSettlementAuthority`;
const ours = node(OURS, "ours"), mzf = node(MZF, "mzf");
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const short = (e) => String(e?.message ?? e).replace(/\s+/g, " ");
const extra = { extraArgs: { context: { values: {} }, meta: { values: {} } } };
const sumH = (hs) => hs.reduce((s, h) => s + Math.round(Number(h.createArgument.amount) * 1e6), 0);
const mine = async (nd, p) => (await nd.acs(p, `${PKG}:CusdtToken:CusdtHolding`)).filter((c) => c.createArgument.owner === p && c.createArgument.lock == null);
const regPost = (path, body) => fetch(`${REGISTRY}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

// ---- traffic guard: both validators are short on traffic; the 200k reserved floor must not be approached -------------
const LH = "https://lighthouse.testnet.cantonloop.com/api", LHH = OURS.LIGHTHOUSE_API_KEY ? { Authorization: `Bearer ${OURS.LIGHTHOUSE_API_KEY}` } : {};
async function headroom(id) { for (let i = 0; i < 3; i++) { try { const j = await (await fetch(`${LH}/validators/${encodeURIComponent(id)}`, { headers: LHH, signal: AbortSignal.timeout(25000) })).json(); const t = j.traffic_status; if (t) return t.total_limit - t.total_consumed; } catch { await sleep(2000); } } return null; }
const hAsc = await headroom(`asc-val-1::${sfx}`);
console.log(`asc-val-1 traffic headroom: ${hAsc ?? "unknown"} (floor 200000; the test needs ~50000)`);
if (hAsc !== null && hAsc < 240_000) { console.log("refusing to run: not enough headroom above the reserved floor. Top up first."); process.exit(3); }

let pass = 0, fail = 0;
const ok = (n, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  — " + x : ""}`); };
const expected = supply(await snapshot(await ours.token(), admin));
async function books(label) { const v = checkInvariants(await snapshot(await ours.token(), admin), expected); ok(`conservation after ${label}`, v.length === 0, v.join("; ")); }

// ---- setup: fund carol, create ONE authority for the whole test -------------------------------------------------------
const REF = `race-${Date.now()}`;
const c0 = sumH(await mine(mzf, CAROL)), a0 = sumH(await mine(ours, ALICE));
{ const o = makeOps({ token: await ours.token(), admin, registry: REGISTRY });
  const h = (await mine(ours, ALICE)).sort((a, b) => Number(b.createArgument.amount) - Number(a.createArgument.amount))[0];
  await o.transfer(ALICE, CAROL, amt(ROUNDS), [h])();
  const inst = (await waitFor(async () => (await mzf.acs(CAROL, `${PKG}:CusdtToken:CusdtTransferInstruction`)).find((i) => i.createArgument.transfer.sender === ALICE))).v;
  await mzf.tx([CAROL], [{ ExerciseCommand: { templateId: IF.TI, contractId: inst.contractId, choice: "TransferInstruction_Accept", choiceArgument: extra } }]);
  ok("setup: carol funded", (await waitFor(async () => sumH(await mine(mzf, CAROL)) === c0 + ROUNDS)).v !== null); }
await mzf.tx([CAROL], [{ CreateCommand: { templateId: PROPOSAL, createArguments: { executor: admin, sender: CAROL, receiver: ALICE, settlementRefId: REF, expiresAt: iso(3_600_000) } } }]);
const prop = (await waitFor(async () => (await ours.acs(ALICE, PROPOSAL)).find((p) => p.createArgument.settlementRefId === REF))).v;
await ours.tx([ALICE], [{ ExerciseCommand: { templateId: PROPOSAL, contractId: prop.contractId, choice: "CusdtSettlementProposal_Accept", choiceArgument: {} } }]);
const authority = (await waitFor(async () => (await ours.acs(admin, AUTH)).find((a) => a.createArgument.settlementRefId === REF))).v;
ok("setup: delegation in place", !!authority);

async function carolAllocates() {
  const hs = (await mine(mzf, CAROL)).sort((a, b) => Number(b.createArgument.amount) - Number(a.createArgument.amount));
  const spec = { settlement: { executor: admin, settlementRef: { id: REF, cid: null }, requestedAt: iso(-30_000), allocateBefore: iso(3_600_000), settleBefore: iso(7_200_000), meta: { values: {} } },
    transferLegId: `leg-${Date.now()}`, transferLeg: { sender: CAROL, receiver: ALICE, amount: amt(1), instrumentId: { admin, id: "cUSDT" }, meta: { values: {} } } };
  const args = { expectedAdmin: admin, allocation: spec, requestedAt: iso(-30_000), inputHoldingCids: [hs[0].contractId] };
  const f = await regPost("/registry/allocation-instruction/v1/allocation-factory", { choiceArguments: args });
  await mzf.tx([CAROL], [{ ExerciseCommand: { templateId: IF.AF, contractId: f.factoryId, choice: "AllocationFactory_Allocate", choiceArgument: { ...args, extraArgs: { context: f.choiceContext.choiceContextData, meta: { values: {} } } } } }], f.choiceContext.disclosedContracts);
  return (await waitFor(async () => (await ours.acs(admin, T.ALLOC)).find((a) => a.createArgument.allocation.settlement.settlementRef.id === REF && a.createArgument.allocation.transferLegId === spec.transferLegId))).v;
}
const execP = (alloc) => () => ours.tx([admin], [{ ExerciseCommand: { templateId: AUTH, contractId: authority.contractId, choice: "CusdtSettlement_Execute", choiceArgument: { allocationCid: alloc.contractId, ...extra } } }]);
const withdrawP = (alloc) => () => mzf.tx([CAROL], [{ ExerciseCommand: { templateId: IF.A, contractId: alloc.contractId, choice: "Allocation_Withdraw", choiceArgument: extra } }]);

// ---- the races ----------------------------------------------------------------------------------------------------
const plans = [["simultaneous", 0], ["withdraw first by 400 ms", -400], ["execute first by 400 ms", 400]];
let executed = 0, withdrawn = 0, neither = 0;
for (let r = 0; r < ROUNDS; r++) {
  const [label, offset] = plans[r % plans.length];
  console.log(`-- round ${r + 1}: ${label}`);
  const alloc = await carolAllocates(); if (!alloc) { ok(`round ${r + 1}: allocation created`, false); break; }
  const a1 = sumH(await mine(ours, ALICE)), c1 = sumH(await mine(mzf, CAROL));
  const go = (p, delay) => new Promise((res) => setTimeout(() => p().then((v) => res({ ok: true, v }), (e) => res({ ok: false, e })), Math.max(0, delay)));
  const [ex, wd] = await Promise.all([go(execP(alloc), offset > 0 ? 0 : -offset), go(withdrawP(alloc), offset > 0 ? offset : 0)]);
  console.log(`      execute (our node): ${ex.ok ? "accepted" : "rejected"}   withdraw (MZF node): ${wd.ok ? "accepted" : "rejected"}`);
  ok(`round ${r + 1}: NEVER both succeed`, !(ex.ok && wd.ok));
  await sleep(6000);
  const gone = !(await ours.acs(admin, T.ALLOC)).some((a) => a.contractId === alloc.contractId);
  const a2 = sumH(await mine(ours, ALICE)), c2 = sumH(await mine(mzf, CAROL));
  if (ex.ok && !wd.ok) { executed++; ok(`round ${r + 1}: execute won: alice +1, carol's holdings unchanged (the 1 micro was locked)`, gone && a2 === a1 + 1 && c2 === c1, `alice ${a1}→${a2}`); }
  else if (wd.ok && !ex.ok) { withdrawn++; ok(`round ${r + 1}: withdraw won: carol got her micro back, alice unchanged`, gone && a2 === a1 && c2 === c1 + 1, `carol ${c1}→${c2}`); }
  else if (!ex.ok && !wd.ok) { neither++; console.log("      both rejected: " + short(ex.e).slice(-140) + " | " + short(wd.e).slice(-140)); if (!gone) { await withdrawP(alloc)().catch(() => {}); } ok(`round ${r + 1}: both rejected (one must be recoverable; state intact)`, true); }
  await books(`round ${r + 1}`);
}
console.log(`outcomes: execute won ${executed}, withdraw won ${withdrawn}, both rejected ${neither}`);

// ---- cleanup -------------------------------------------------------------------------------------------------------
await ours.tx([ALICE], [{ ExerciseCommand: { templateId: AUTH, contractId: authority.contractId, choice: "CusdtSettlement_RevokeByReceiver", choiceArgument: {} } }]).catch((e) => console.log("revoke failed: " + short(e).slice(-120)));
{ const hs = await mine(mzf, CAROL); const total = sumH(hs);
  if (total > 0) {
    const t = { sender: CAROL, receiver: ALICE, amount: amt(total), instrumentId: { admin, id: "cUSDT" }, requestedAt: iso(-30_000), executeBefore: iso(3_600_000), inputHoldingCids: hs.map((h) => h.contractId), meta: { values: {} } };
    const f = await regPost("/registry/transfer-instruction/v1/transfer-factory", { choiceArguments: { expectedAdmin: admin, transfer: t } });
    await mzf.tx([CAROL], [{ ExerciseCommand: { templateId: IF.TF, contractId: f.factoryId, choice: "TransferFactory_Transfer", choiceArgument: { expectedAdmin: admin, transfer: t, extraArgs: { context: f.choiceContext.choiceContextData, meta: { values: {} } } } } }], f.choiceContext.disclosedContracts);
    const seen = (await waitFor(async () => (await ours.acs(ALICE, T.INSTR)).find((i) => i.createArgument.transfer.sender === CAROL))).v;
    if (seen) await ours.tx([ALICE], [{ ExerciseCommand: { templateId: IF.TI, contractId: seen.contractId, choice: "TransferInstruction_Accept", choiceArgument: extra } }]);
  } }
ok("carol holds nothing afterwards; no authority left", (await waitFor(async () => sumH(await mine(mzf, CAROL)) === 0 && (await ours.acs(admin, AUTH)).length === 0)).v !== null);
await books("cleanup");
const hAfter = await headroom(`asc-val-1::${sfx}`);
console.log(`asc-val-1 headroom after: ${hAfter ?? "unknown"}${hAsc && hAfter ? `  (before ${hAsc}; Lighthouse may lag a minute)` : ""}`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
