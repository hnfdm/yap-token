// Remaining cheap checks (all on OUR node, except section 1) plus the THIRD participant (cryptolampung, party "dave").
//   node scripts/25-gaps-and-third-node.mjs      needs .env.testnet and .env.cl (run 20-mzf-setup with CUSDT_ENV_FILE=.env.cl first)
// 1. offer alice -> dave (third node), dave accepts   2. duplicate cids in Merge   3. locked holdings can't be burnt/split/merged/spent
// 4. duplicate preapprovals for one receiver.  The third node has ~10k traffic above its reserved floor: section 1 costs ONE transaction there
// and is skipped unless Lighthouse shows it (nearly) untouched.
import { loadEnv } from "./lib.mjs";
import { T, snapshot, supply, checkInvariants } from "./invariants.mjs";
import { makeOps, amt, IF } from "./ops.mjs";
import { node, waitFor, sleep } from "./nodes.mjs";

const OURS = loadEnv(".env.testnet"), CL = loadEnv(".env.cl");
if (OURS.INSECURE_TLS === "1" || CL.INSECURE_TLS === "1") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const admin = OURS.CUSDT_ADMIN_PARTY, sfx = admin.split("::")[1], ALICE = `cusdt-alice::${sfx}`, BOB = `cusdt-bob::${sfx}`, DAVE = CL.CUSDT_CL_DAVE;
const REGISTRY = process.env.CUSDT_REGISTRY_URL || "https://registry-testnet.airdropasc.com";
const PKG = "#cusdt-token", HOLD = `${PKG}:CusdtToken:CusdtHolding`, PRE = `${PKG}:CusdtToken:CusdtTransferPreapproval`;
const ours = node(OURS, "ours"), cl = node(CL, "cl");
const short = (e) => String(e?.message ?? e).replace(/\s+/g, " ");
const extra = { extraArgs: { context: { values: {} }, meta: { values: {} } } };
const sumH = (hs) => hs.reduce((s, h) => s + Math.round(Number(h.createArgument.amount) * 1e6), 0);
const free = async (nd, p) => (await nd.acs(p, HOLD)).filter((c) => c.createArgument.owner === p && c.createArgument.lock == null);
const rejected = async (fn) => { try { await fn(); return null; } catch (e) { return short(e); } };

const LH = "https://lighthouse.testnet.cantonloop.com/api", LHH = OURS.LIGHTHOUSE_API_KEY ? { Authorization: `Bearer ${OURS.LIGHTHOUSE_API_KEY}` } : {};
async function headroom(id) { for (let i = 0; i < 3; i++) { try { const j = await (await fetch(`${LH}/validators/${encodeURIComponent(id)}`, { headers: LHH, signal: AbortSignal.timeout(25000) })).json(); const t = j.traffic_status; if (t) return t.total_limit - t.total_consumed; } catch { await sleep(2000); } } return null; }
const hOurs = await headroom(`asc-val-1::${sfx}`), hCl = await headroom(`cryptolampung-testnet-1::${DAVE.split("::")[1]}`);
console.log(`traffic headroom — ours: ${hOurs}, cryptolampung: ${hCl} (floor 200000 each)`);
if (hOurs !== null && hOurs < 230_000) { console.log("our node is too close to its floor; top up first."); process.exit(3); }

let pass = 0, fail = 0;
const ok = (n, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  — " + x : ""}`); };
const expected = supply(await snapshot(await ours.token(), admin));
async function books(label) { const v = checkInvariants(await snapshot(await ours.token(), admin), expected); ok(`conservation after ${label}`, v.length === 0, v.join("; ")); }
async function group(name, fn) { console.log(`-- ${name}`); try { await fn(); } catch (e) { fail++; console.log(`FAIL  ${name} threw: ${short(e).slice(0, 400)}`); } }
const o = async () => makeOps({ token: await ours.token(), admin, registry: REGISTRY });
const sortDesc = (hs) => hs.sort((a, b) => Number(b.createArgument.amount) - Number(a.createArgument.amount));

await group("1. third node: alice -> dave offer, dave accepts (1 tx on cryptolampung)", async () => {
  if (hCl === null || hCl < 209_000) { console.log(`      SKIPPED: cryptolampung headroom ${hCl} (needs >= 209000: node must be nearly untouched)`); return; }
  const d0 = sumH(await free(cl, DAVE));
  await (await o()).transfer(ALICE, DAVE, amt(2), [sortDesc(await free(ours, ALICE))[0]])();
  const seen = await waitFor(async () => (await cl.acs(DAVE, `${PKG}:CusdtToken:CusdtTransferInstruction`)).find((i) => i.createArgument.transfer.sender === ALICE));
  ok("the offer reaches the THIRD participant", !!seen.v, `after ~${seen.s}s`);
  if (!seen.v) return;
  await cl.tx([DAVE], [{ ExerciseCommand: { templateId: IF.TI, contractId: seen.v.contractId, choice: "TransferInstruction_Accept", choiceArgument: extra } }]);
  const got = await waitFor(async () => sumH(await free(cl, DAVE)) === d0 + 2);
  ok("dave accepted on his own node and holds the 2 micro", !!got.v);
  await books("section 1");
});

await group("2. duplicate cids in Merge", async () => {
  const hs = sortDesc(await free(ours, ALICE)); if (hs.length < 3) { console.log("      SKIPPED: alice needs 3 holdings"); return; }
  const [a, b] = hs; const before = sumH(hs);
  const m = (cid, others) => () => ours.tx([ALICE], [{ ExerciseCommand: { templateId: HOLD, contractId: cid, choice: "CusdtHolding_Merge", choiceArgument: { otherCids: others } } }]);
  const e1 = await rejected(m(a.contractId, [b.contractId, b.contractId]));
  ok("Merge with the same holding listed twice is rejected (would double-count)", !!e1, e1 ? e1.slice(-120) : "ACCEPTED");
  const e2 = await rejected(m(a.contractId, [a.contractId]));
  ok("Merge of a holding with ITSELF is rejected", !!e2, e2 ? e2.slice(-120) : "ACCEPTED");
  ok("alice's total unchanged by the rejected merges", sumH(await free(ours, ALICE)) === before);
  await books("section 2");
});

await group("3. locked holdings (inside an allocation) cannot be burnt, split, merged or spent", async () => {
  const ref = `lock-${Date.now()}`; const hs = sortDesc(await free(ours, ALICE));
  await (await o()).allocate(ALICE, BOB, amt(1), [hs[0]], ref)();
  const alloc = (await waitFor(async () => (await ours.acs(admin, T.ALLOC)).find((a) => a.createArgument.allocation.settlement.settlementRef.id === ref))).v;
  const locked = (await waitFor(async () => (await ours.acs(ALICE, HOLD)).find((c) => c.createArgument.lock != null && c.createArgument.owner === ALICE))).v;
  ok("alice sees the locked holding", !!alloc && !!locked);
  if (!alloc || !locked) return;
  const lc = locked.contractId, other = sortDesc(await free(ours, ALICE))[0];
  const ex = (cid, choice, args) => () => ours.tx([ALICE], [{ ExerciseCommand: { templateId: HOLD, contractId: cid, choice, choiceArgument: args } }]);
  const cases = [
    ["Burn on a locked holding", ex(lc, "CusdtHolding_Burn", {})],
    ["Split on a locked holding", ex(lc, "CusdtHolding_Split", { splitAmount: "0.0000005" })],
    ["Merge INTO a locked holding", ex(lc, "CusdtHolding_Merge", { otherCids: [other.contractId] })],
    ["Merge a locked holding INTO a free one", ex(other.contractId, "CusdtHolding_Merge", { otherCids: [lc] })],
    ["use the locked holding as transfer input", async () => (await o()).transfer(ALICE, BOB, amt(1), [locked])()],
    ["use the locked holding as allocation input", async () => (await o()).allocate(ALICE, BOB, amt(1), [locked], ref + "-2")()],
  ];
  for (const [name, fn] of cases) { const e = await rejected(fn); ok(`${name} is rejected`, !!e, e ? e.slice(-100) : "ACCEPTED"); }
  await (await o()).al([ALICE], alloc.contractId, "Allocation_Withdraw")();
  ok("withdraw releases the lock", !!(await waitFor(async () => (await ours.acs(ALICE, HOLD)).every((c) => c.createArgument.lock == null))).v);
  await books("section 3");
});

await group("4. duplicate preapprovals for one receiver", async () => {
  const have = new Set((await ours.acs(BOB, PRE)).map((p) => p.contractId));
  const [adm] = await ours.acs(admin, T.ADMIN);
  for (let i = 0; i < 2; i++) await ours.tx([admin], [{ ExerciseCommand: { templateId: T.ADMIN, contractId: adm.contractId, choice: "CusdtAdmin_CreatePreapproval", choiceArgument: { receiver: BOB } } }]);
  const mineNew = (await ours.acs(BOB, PRE)).filter((p) => !have.has(p.contractId));
  ok("the admin can create several preapprovals for the same receiver (no uniqueness)", mineNew.length === 2, `${mineNew.length} new`);
  const b0 = sumH(await free(ours, BOB));
  await (await o()).transfer(ALICE, BOB, amt(1), [sortDesc(await free(ours, ALICE))[0]])();
  const got = await waitFor(async () => sumH(await free(ours, BOB)) === b0 + 1);
  ok("a direct transfer still works with duplicates present (registry picks one)", !!got.v);
  const left = (await ours.acs(BOB, PRE)).filter((p) => !have.has(p.contractId));
  ok("the preapprovals are not consumed by the transfer", left.length === 2, `${left.length} left`);
  for (const p of mineNew) await ours.tx([BOB], [{ ExerciseCommand: { templateId: PRE, contractId: p.contractId, choice: "CusdtTransferPreapproval_Cancel", choiceArgument: {} } }]);
  ok("bob cancelled the duplicates; the original state is restored", (await ours.acs(BOB, PRE)).length === have.size);
  await books("section 4");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
