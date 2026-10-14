// Cross-participant settlement WITH a delegation: executor = admin and receiver = alice on OUR node, sender = carol on
// the MZF node. Test 21 showed that Allocation_ExecuteTransfer cannot be submitted by one node for all three; here carol
// and alice sign a CusdtSettlementAuthority so the executor settles alone, from its own node.
//   needs cusdt-token >= 0.4.0 uploaded on BOTH nodes (CUSDT_ENV_FILE=.env.mzf node scripts/1-upload-dar.mjs, and the same without it)
import { loadEnv } from "./lib.mjs";
import { T, snapshot, supply, checkInvariants } from "./invariants.mjs";
import { makeOps, amt, IF } from "./ops.mjs";
import { node, waitFor } from "./nodes.mjs";

const OURS = loadEnv(".env.testnet"), MZF = loadEnv(".env.mzf");
if (OURS.INSECURE_TLS === "1" || MZF.INSECURE_TLS === "1") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const admin = OURS.CUSDT_ADMIN_PARTY, suffix = admin.split("::")[1];
const ALICE = `cusdt-alice::${suffix}`, CAROL = MZF.CUSDT_MZF_CAROL;
const REGISTRY = process.env.CUSDT_REGISTRY_URL || "https://registry-testnet.cryptolampung.space";
const PKG = "#cusdt-token";
const PROPOSAL = `${PKG}:CusdtToken:CusdtSettlementProposal`, AUTH = `${PKG}:CusdtToken:CusdtSettlementAuthority`;
const short = (e) => String(e?.message ?? e).replace(/\s+/g, " ");
const ours = node(OURS, "ours"), mzf = node(MZF, "mzf");
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const sumH = (hs) => hs.reduce((s, h) => s + Math.round(Number(h.createArgument.amount) * 1e6), 0);
const mine = async (nd, p) => (await nd.acs(p, `${PKG}:CusdtToken:CusdtHolding`)).filter((c) => c.createArgument.owner === p && c.createArgument.lock == null);
const regPost = (path, body) => fetch(`${REGISTRY}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const extra = { extraArgs: { context: { values: {} }, meta: { values: {} } } };

let pass = 0, fail = 0;
const ok = (n, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  — " + x : ""}`); };
async function mustFail(name, fn, want) { try { await fn(); ok(name, false, "unexpectedly succeeded"); } catch (e) { const m = short(e); const hit = want ? want.test(m) : true; ok(name, hit, hit ? `rejected${want ? ` (${want.source})` : ""}` : `rejected for another reason: ${m.slice(-170)}`); } }
const expected = supply(await snapshot(await ours.token(), admin));
async function books(label) { const v = checkInvariants(await snapshot(await ours.token(), admin), expected); ok(`conservation after ${label}`, v.length === 0, v.join("; ")); }

/** carol (remote sender) allocates `micro` for a settlement; returns the allocation as seen by the admin on OUR node */
async function carolAllocates(ref, micro) {
  const all = (await mine(mzf, CAROL)).sort((a, b) => Number(b.createArgument.amount) - Number(a.createArgument.amount));
  const inputs = []; let acc = 0; for (const h of all) { inputs.push(h); acc += Math.round(Number(h.createArgument.amount) * 1e6); if (acc >= micro) break; }
  if (acc < micro) throw new Error(`carol has only ${acc} micro, needs ${micro}`);
  const spec = { settlement: { executor: admin, settlementRef: { id: ref, cid: null }, requestedAt: iso(-30_000), allocateBefore: iso(3_600_000), settleBefore: iso(7_200_000), meta: { values: {} } },
    transferLegId: "leg-1", transferLeg: { sender: CAROL, receiver: ALICE, amount: amt(micro), instrumentId: { admin, id: "cUSDT" }, meta: { values: {} } } };
  const args = { expectedAdmin: admin, allocation: spec, requestedAt: iso(-30_000), inputHoldingCids: inputs.map((h) => h.contractId) };
  const f = await regPost("/registry/allocation-instruction/v1/allocation-factory", { choiceArguments: args });
  await mzf.tx([CAROL], [{ ExerciseCommand: { templateId: IF.AF, contractId: f.factoryId, choice: "AllocationFactory_Allocate", choiceArgument: { ...args, extraArgs: { context: f.choiceContext.choiceContextData, meta: { values: {} } } } } }], f.choiceContext.disclosedContracts);
  return (await waitFor(async () => (await ours.acs(admin, T.ALLOC)).find((a) => a.createArgument.allocation.settlement.settlementRef.id === ref))).v;
}
/** carol proposes, alice accepts (each on her own node); returns the authority contract as seen by the admin */
async function delegate(ref, ttlMs = 3_600_000) {
  await mzf.tx([CAROL], [{ CreateCommand: { templateId: PROPOSAL, createArguments: { executor: admin, sender: CAROL, receiver: ALICE, settlementRefId: ref, expiresAt: iso(ttlMs) } } }]);
  const prop = (await waitFor(async () => (await ours.acs(ALICE, PROPOSAL)).find((p) => p.createArgument.settlementRefId === ref))).v;
  await ours.tx([ALICE], [{ ExerciseCommand: { templateId: PROPOSAL, contractId: prop.contractId, choice: "CusdtSettlementProposal_Accept", choiceArgument: {} } }]);
  return (await waitFor(async () => (await ours.acs(admin, AUTH)).find((a) => a.createArgument.settlementRefId === ref))).v;
}
const execute = (authCid, allocCid, choice = "CusdtSettlement_Execute") => ours.tx([admin], [{ ExerciseCommand: { templateId: AUTH, contractId: authCid, choice, choiceArgument: { allocationCid: allocCid, ...extra } } }]);

console.log(`alice ${sumH(await mine(ours, ALICE))} micro (ours) | carol ${sumH(await mine(mzf, CAROL))} micro (MZF) | supply ${expected / 1e6}\n`);

// -1. authorities left by an earlier run (0.4.0 contracts could not be archived: Archive needs ALL signatories, across two nodes).
// Revoke them with the 0.4.1 single-party choices: the first by the REMOTE sender (carol, on her node), the rest by alice.
{ const legacy = await ours.acs(admin, AUTH);
  for (const [i, au] of legacy.entries()) {
    try {
      if (i === 0 && au.createArgument.sender === CAROL) {
        await mzf.tx([CAROL], [{ ExerciseCommand: { templateId: AUTH, contractId: au.contractId, choice: "CusdtSettlement_RevokeBySender", choiceArgument: {} } }]);
        ok("an old (0.4.0) authority is revoked by the remote SENDER alone, from her own node", (await waitFor(async () => !(await ours.acs(admin, AUTH)).some((a) => a.contractId === au.contractId))).v !== null);
      } else await ours.tx([ALICE], [{ ExerciseCommand: { templateId: AUTH, contractId: au.contractId, choice: "CusdtSettlement_RevokeByReceiver", choiceArgument: {} } }]);
    } catch (e) { ok(`revoking old authority ${i}`, false, short(e).slice(-200)); }
  }
  if (legacy.length) ok("no stale authorities remain", (await ours.acs(admin, AUTH)).length === 0); }

// 0. fund carol with a few micro (offer alice -> carol, carol accepts on her node)
let c0 = 0;   // carol may already hold some micro from an earlier run: every check below is relative to this
{ c0 = sumH(await mine(mzf, CAROL)); const o = makeOps({ token: await ours.token(), admin, registry: REGISTRY });
  const h = (await mine(ours, ALICE)).sort((a, b) => Number(b.createArgument.amount) - Number(a.createArgument.amount))[0];
  await o.transfer(ALICE, CAROL, amt(4), [h])();
  const inst = (await waitFor(async () => (await mzf.acs(CAROL, `${PKG}:CusdtToken:CusdtTransferInstruction`)).find((i) => i.createArgument.transfer.sender === ALICE))).v;
  await mzf.tx([CAROL], [{ ExerciseCommand: { templateId: IF.TI, contractId: inst.contractId, choice: "TransferInstruction_Accept", choiceArgument: extra } }]);
  ok("setup: carol funded with 4 micro", (await waitFor(async () => sumH(await mine(mzf, CAROL)) === c0 + 4)).v !== null, `she held ${c0} before`); }

const REF = `deleg-${Date.now()}`;
const a0 = sumH(await mine(ours, ALICE));
const authority = await delegate(REF);
ok("carol (MZF) proposed and alice (ours) accepted: the authority exists and the executor sees it", !!authority && authority.createArgument.executor === admin);
const alloc = await carolAllocates(REF, 2);
ok("carol's allocation for that settlement exists", !!alloc);

// ---- negative cases first (nothing may move) ----
const REF_OTHER = `other-${Date.now()}`;
const allocOther = await carolAllocates(REF_OTHER, 1);
await mustFail("authority cannot settle a DIFFERENT settlement's allocation", () => execute(authority.contractId, allocOther.contractId), /different settlement/);
await mustFail("alice (not the executor) cannot use the authority", () => ours.tx([ALICE], [{ ExerciseCommand: { templateId: AUTH, contractId: authority.contractId, choice: "CusdtSettlement_Execute", choiceArgument: { allocationCid: alloc.contractId, ...extra } } }]));
ok("nothing moved yet", sumH(await mine(ours, ALICE)) === a0 && sumH(await mine(mzf, CAROL)) === c0 + 4 - 3);   // 3 micro are locked in the two allocations

// ---- the real settlement ----
await execute(authority.contractId, alloc.contractId);
ok("EXECUTOR ALONE settles across participants: alice +2 micro", (await waitFor(async () => sumH(await mine(ours, ALICE)) === a0 + 2)).v !== null);
ok("the allocation is consumed", (await waitFor(async () => !(await ours.acs(admin, T.ALLOC)).some((a) => a.createArgument.allocation.settlement.settlementRef.id === REF))).v !== null);
await mustFail("the same allocation cannot be settled twice", () => execute(authority.contractId, alloc.contractId));
await books("the settlement");

// ---- cancel through the authority is limited to ITS settlement; cancel the other one through its own authority ----
const authOther = await delegate(REF_OTHER);
await execute(authOther.contractId, allocOther.contractId, "CusdtSettlement_Cancel");
ok("executor cancels the second allocation through its own authority: carol's 1 micro is released", (await waitFor(async () => sumH(await mine(mzf, CAROL)) === c0 + 4 - 2)).v !== null, "2 of her 4 new micro were paid out, 1 released");

// ---- revocation: a signatory (alice) archives the authority; the executor loses the power ----
const REF3 = `revoke-${Date.now()}`;
const auth3 = await delegate(REF3); const alloc3 = await carolAllocates(REF3, 1);
await mustFail("the built-in Archive is NOT enough: it needs both signatories, on two different nodes", () => ours.tx([ALICE], [{ ExerciseCommand: { templateId: AUTH, contractId: auth3.contractId, choice: "Archive", choiceArgument: {} } }]), /requires authorizers|AUTHORIZATION/i);
await ours.tx([ALICE], [{ ExerciseCommand: { templateId: AUTH, contractId: auth3.contractId, choice: "CusdtSettlement_RevokeByReceiver", choiceArgument: {} } }]);
await mustFail("after alice (the receiver) revokes it ALONE, the executor can no longer settle", () => execute(auth3.contractId, alloc3.contractId));
await mzf.tx([CAROL], [{ ExerciseCommand: { templateId: IF.A, contractId: alloc3.contractId, choice: "Allocation_Withdraw", choiceArgument: extra } }]);   // carol takes her money back

// ---- cleanup: leftover authorities, carol's remaining funds back to alice ----
for (const au of (await ours.acs(admin, AUTH))) await ours.tx([ALICE], [{ ExerciseCommand: { templateId: AUTH, contractId: au.contractId, choice: "CusdtSettlement_RevokeByReceiver", choiceArgument: {} } }]).catch(() => {});
ok("no authorities left behind", (await waitFor(async () => (await ours.acs(admin, AUTH)).length === 0, 30000)).v !== null);
{ const hs = await mine(mzf, CAROL); const total = sumH(hs);
  if (total > 0) {
    const t = { sender: CAROL, receiver: ALICE, amount: amt(total), instrumentId: { admin, id: "cUSDT" }, requestedAt: iso(-30_000), executeBefore: iso(3_600_000), inputHoldingCids: hs.map((h) => h.contractId), meta: { values: {} } };
    const f = await regPost("/registry/transfer-instruction/v1/transfer-factory", { choiceArguments: { expectedAdmin: admin, transfer: t } });
    await mzf.tx([CAROL], [{ ExerciseCommand: { templateId: IF.TF, contractId: f.factoryId, choice: "TransferFactory_Transfer", choiceArgument: { expectedAdmin: admin, transfer: t, extraArgs: { context: f.choiceContext.choiceContextData, meta: { values: {} } } } } }], f.choiceContext.disclosedContracts);
    const seen = (await waitFor(async () => (await ours.acs(ALICE, T.INSTR)).find((i) => i.createArgument.transfer.sender === CAROL))).v;
    if (seen) await ours.tx([ALICE], [{ ExerciseCommand: { templateId: IF.TI, contractId: seen.contractId, choice: "TransferInstruction_Accept", choiceArgument: extra } }]);
  } }
ok("carol holds nothing afterwards", (await waitFor(async () => sumH(await mine(mzf, CAROL)) === 0)).v !== null);
await books("cleanup");
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
