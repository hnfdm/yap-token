// THREE participants in one settlement: sender carol (MZF node), receiver dave (cryptolampung node), executor = admin (OUR node).
// carol and dave sign a YapSettlementAuthority (proposal on one node, accept on another); the executor settles alone from its own node.
//   node scripts/27-three-node-settlement.mjs     needs .env.testnet, .env.mzf, .env.cl and yap-token 0.4.1 on all three nodes
// Costs on the cryptolampung node: 2 transactions (accept the proposal, revoke); dave's received micro are left with him.
import { loadEnv } from "./lib.mjs";
import { T, snapshot, supply, checkInvariants } from "./invariants.mjs";
import { makeOps, amt, IF } from "./ops.mjs";
import { node, waitFor, sleep } from "./nodes.mjs";

const OURS = loadEnv(".env.testnet"), MZF = loadEnv(".env.mzf"), CL = loadEnv(".env.cl");
if ([OURS, MZF, CL].some((e) => e.INSECURE_TLS === "1")) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const admin = OURS.CUSDT_ADMIN_PARTY, sfx = admin.split("::")[1], ALICE = (process.env.CUSDT_ALICE || `cusdt-alice::${sfx}`), CAROL = MZF.CUSDT_MZF_CAROL, DAVE = CL.CUSDT_CL_DAVE;
const REGISTRY = process.env.CUSDT_REGISTRY_URL || "https://registry-testnet.cryptolampung.space";
const PKG = "#yap-token", PROPOSAL = `${PKG}:YapToken:YapSettlementProposal`, AUTH = `${PKG}:YapToken:YapSettlementAuthority`, HOLD = `${PKG}:YapToken:YapHolding`;
const ours = node(OURS, "ours"), mzf = node(MZF, "mzf"), cl = node(CL, "cl");
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const short = (e) => String(e?.message ?? e).replace(/\s+/g, " ");
const extra = { extraArgs: { context: { values: {} }, meta: { values: {} } } };
const sumH = (hs) => hs.reduce((s, h) => s + Math.round(Number(h.createArgument.amount) * 1e6), 0);
const mine = async (nd, p) => (await nd.acs(p, HOLD)).filter((c) => c.createArgument.owner === p && c.createArgument.lock == null);
const regPost = (path, body) => fetch(`${REGISTRY}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  — " + x : ""}`); };
const expected = supply(await snapshot(await ours.token(), admin));
async function books(label) { const v = checkInvariants(await snapshot(await ours.token(), admin), expected); ok(`conservation after ${label}`, v.length === 0, v.join("; ")); }

const LH = "https://lighthouse.testnet.cantonloop.com/api", LHH = OURS.LIGHTHOUSE_API_KEY ? { Authorization: `Bearer ${OURS.LIGHTHOUSE_API_KEY}` } : {};
async function headroom(id) { for (let i = 0; i < 3; i++) { try { const j = await (await fetch(`${LH}/validators/${encodeURIComponent(id)}`, { headers: LHH, signal: AbortSignal.timeout(25000) })).json(); const t = j.traffic_status; if (t) return t.total_limit - t.total_consumed; } catch { await sleep(2000); } } return null; }
console.log(`headroom — ours ${await headroom(`asc-val-1::${sfx}`)}, mzf ${await headroom(`mzf-validator-1::${CAROL.split("::")[1]}`)}, cryptolampung ${await headroom(`cryptolampung-testnet-1::${DAVE.split("::")[1]}`)}`);

// 0. fund carol (alice -> carol offer, carol accepts on the MZF node)
const c0 = sumH(await mine(mzf, CAROL)), d0 = sumH(await mine(cl, DAVE));
{ const o = makeOps({ token: await ours.token(), admin, registry: REGISTRY });
  const h = (await mine(ours, ALICE)).sort((a, b) => Number(b.createArgument.amount) - Number(a.createArgument.amount))[0];
  await o.transfer(ALICE, CAROL, amt(3), [h])();
  const inst = (await waitFor(async () => (await mzf.acs(CAROL, `${PKG}:YapToken:YapTransferInstruction`)).find((i) => i.createArgument.transfer.sender === ALICE))).v;
  await mzf.tx([CAROL], [{ ExerciseCommand: { templateId: IF.TI, contractId: inst.contractId, choice: "TransferInstruction_Accept", choiceArgument: extra } }]);
  ok("setup: carol funded with 3 micro", (await waitFor(async () => sumH(await mine(mzf, CAROL)) === c0 + 3)).v !== null); }

// 1. delegation signed on TWO foreign nodes: carol proposes (MZF), dave accepts (cryptolampung)
const REF = `three-${Date.now()}`;
await mzf.tx([CAROL], [{ CreateCommand: { templateId: PROPOSAL, createArguments: { executor: admin, sender: CAROL, receiver: DAVE, settlementRefId: REF, expiresAt: iso(3_600_000) } } }]);
const prop = await waitFor(async () => (await cl.acs(DAVE, PROPOSAL)).find((p) => p.createArgument.settlementRefId === REF));
ok("dave (third node) sees carol's proposal", !!prop.v, `after ~${prop.s}s`);
await cl.tx([DAVE], [{ ExerciseCommand: { templateId: PROPOSAL, contractId: prop.v.contractId, choice: "YapSettlementProposal_Accept", choiceArgument: {} } }]);
const authority = (await waitFor(async () => (await ours.acs(admin, AUTH)).find((a) => a.createArgument.settlementRefId === REF))).v;
ok("the authority (signed by carol@MZF + dave@cryptolampung) is visible to the executor on OUR node", !!authority && authority.createArgument.sender === CAROL && authority.createArgument.receiver === DAVE);

// 2. carol allocates 2 micro for dave
const hs = (await mine(mzf, CAROL)).sort((a, b) => Number(b.createArgument.amount) - Number(a.createArgument.amount));
const spec = { settlement: { executor: admin, settlementRef: { id: REF, cid: null }, requestedAt: iso(-30_000), allocateBefore: iso(3_600_000), settleBefore: iso(7_200_000), meta: { values: {} } },
  transferLegId: "leg-1", transferLeg: { sender: CAROL, receiver: DAVE, amount: amt(2), instrumentId: { admin, id: "YAP" }, meta: { values: {} } } };
const args = { expectedAdmin: admin, allocation: spec, requestedAt: iso(-30_000), inputHoldingCids: [hs[0].contractId] };
const f = await regPost("/registry/allocation-instruction/v1/allocation-factory", { choiceArguments: args });
await mzf.tx([CAROL], [{ ExerciseCommand: { templateId: IF.AF, contractId: f.factoryId, choice: "AllocationFactory_Allocate", choiceArgument: { ...args, extraArgs: { context: f.choiceContext.choiceContextData, meta: { values: {} } } } } }], f.choiceContext.disclosedContracts);
const alloc = (await waitFor(async () => (await ours.acs(admin, T.ALLOC)).find((a) => a.createArgument.allocation.settlement.settlementRef.id === REF))).v;
ok("carol's allocation (receiver on the third node) is visible to the executor", !!alloc);

// 3. the executor alone settles: three nodes, one transaction submitted on the executor's node
let executed = true; try { await ours.tx([admin], [{ ExerciseCommand: { templateId: AUTH, contractId: authority.contractId, choice: "YapSettlement_Execute", choiceArgument: { allocationCid: alloc.contractId, ...extra } } }]); } catch (e) { executed = false; console.log("      execute failed: " + short(e).slice(-400)); }
ok("EXECUTOR ALONE settles a sender on node B and a receiver on node C", executed);
const got = await waitFor(async () => sumH(await mine(cl, DAVE)) === d0 + 2);
ok("dave received the 2 micro on the cryptolampung node", !!got.v, `after ~${got.s}s`);
ok("carol keeps her remaining micro on the MZF node", sumH(await mine(mzf, CAROL)) === c0 + 1);
ok("the allocation is consumed", !(await ours.acs(admin, T.ALLOC)).some((a) => a.contractId === alloc.contractId));
await books("the three-node settlement");

// 4. revoke by dave alone (receiver on node C): executor loses the power
await cl.tx([DAVE], [{ ExerciseCommand: { templateId: AUTH, contractId: authority.contractId, choice: "YapSettlement_RevokeByReceiver", choiceArgument: {} } }]);
ok("dave revokes the authority alone, from his own node", (await waitFor(async () => !(await ours.acs(admin, AUTH)).some((a) => a.contractId === authority.contractId))).v !== null);

// 5. cleanup: carol's leftover back to alice (dave keeps his micro: that avoids more traffic on his node)
{ const left = await mine(mzf, CAROL); const total = sumH(left);
  if (total > 0) {
    const t = { sender: CAROL, receiver: ALICE, amount: amt(total), instrumentId: { admin, id: "YAP" }, requestedAt: iso(-30_000), executeBefore: iso(3_600_000), inputHoldingCids: left.map((h) => h.contractId), meta: { values: {} } };
    const ff = await regPost("/registry/transfer-instruction/v1/transfer-factory", { choiceArguments: { expectedAdmin: admin, transfer: t } });
    await mzf.tx([CAROL], [{ ExerciseCommand: { templateId: IF.TF, contractId: ff.factoryId, choice: "TransferFactory_Transfer", choiceArgument: { expectedAdmin: admin, transfer: t, extraArgs: { context: ff.choiceContext.choiceContextData, meta: { values: {} } } } } }], ff.choiceContext.disclosedContracts);
    const seen = (await waitFor(async () => (await ours.acs(ALICE, T.INSTR)).find((i) => i.createArgument.transfer.sender === CAROL))).v;
    if (seen) await ours.tx([ALICE], [{ ExerciseCommand: { templateId: IF.TI, contractId: seen.contractId, choice: "TransferInstruction_Accept", choiceArgument: extra } }]);
  } }
ok("carol holds nothing afterwards", (await waitFor(async () => sumH(await mine(mzf, CAROL)) === 0)).v !== null);
await books("cleanup");
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
