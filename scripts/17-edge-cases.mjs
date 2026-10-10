// Edge cases on testnet: malformed / hostile transfers, allocation misuse, and what the ISSUER can and cannot do.
// Conservation is re-checked after every group; deliberate supply changes are accounted for in `expected`.
import { getToken, acs, need } from "./lib.mjs";
import { T, mu, snapshot, supply, checkInvariants } from "./invariants.mjs";
import { makeOps, amt } from "./ops.mjs";

const admin = need("CUSDT_ADMIN_PARTY");
const suffix = admin.split("::")[1];
const ALICE = `cusdt-alice::${suffix}`, BOB = `cusdt-bob::${suffix}`;
const GHOST = `ghost-nobody::1220${"a".repeat(64)}`;
const token = await getToken();
const { transfer, allocate, ti, al, tpl } = makeOps({ token, admin, registry: process.env.CUSDT_REGISTRY_URL || "http://localhost:8787" });
const snap = () => snapshot(token, admin);
const free = (S, p) => S.H.filter((h) => h.createArgument.owner === p && h.createArgument.lock == null).sort((a, b) => mu(b.createArgument.amount) - mu(a.createArgument.amount));
const short = (e) => String(e?.message ?? e).replace(/\s+/g, " ");

let pass = 0, fail = 0, expected = 0, n = 0;
const ok = (name, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}  ${name}${x ? "  — " + x : ""}`); };
async function mustFail(name, thunk, want) {
  try { await thunk(); ok(name, false, "unexpectedly succeeded"); }
  catch (e) { const m = short(e); const hit = want ? want.test(m) : true; ok(name, hit, hit ? `rejected${want ? ` (${want.source})` : ""}` : `rejected for another reason: ${m.slice(-160)}`); }
}
async function invariants(label) { const v = checkInvariants(await snap(), expected); ok(`invariants after ${label}`, v.length === 0, v.join("; ")); }
const ref = () => `edge-${Date.now()}-${n++}`;
const findAlloc = async (r) => (await snap()).A.find((a) => a.createArgument.allocation.settlement.settlementRef.id === r);
async function settleAll() {
  const S = await snap();
  await Promise.allSettled([...S.I.map((i) => ti(i.createArgument.transfer.sender, i.contractId, "TransferInstruction_Withdraw")()), ...S.A.map((a) => al([a.createArgument.allocation.transferLeg.sender], a.contractId, "Allocation_Withdraw")())]);
}
for (const c of (await acs(token, admin, T.PRE)).filter((c) => c.createArgument.receiver === BOB)) await tpl([BOB], T.PRE, c.contractId, "CusdtTransferPreapproval_Cancel")();
await settleAll();
const S0 = await snap(); expected = supply(S0);
const v0 = checkInvariants(S0, expected); if (v0.length) { console.log("pre-existing violations: " + v0.join("; ")); process.exit(2); }
const big = () => free(S0, ALICE)[0];
console.log(`start: supply ${expected / 1e6}, alice's biggest holding ${mu(big().createArgument.amount) / 1e6}\n`);
const aliceFree = async () => free(await snap(), ALICE);

// ---- transfer edges ----------------------------------------------------------------------------
console.log("-- transfer");
await mustFail("amount 0", transfer(ALICE, BOB, "0.0000000000", [big()]), /positive/i);
await mustFail("negative amount", transfer(ALICE, BOB, "-1.0000000000", [big()]), /positive/i);
await mustFail("amount 1e20 (more than exists)", transfer(ALICE, BOB, "100000000000000000000.0000000000", [big()]), /insufficient funds/i);
await mustFail("amount 1e29 (beyond the Decimal range)", transfer(ALICE, BOB, "100000000000000000000000000000.0000000000", [big()]));
await mustFail("receiver is an unknown party", transfer(ALICE, GHOST, amt(1), [big()]));
await mustFail("bob submits alice's transfer (wrong authority)", transfer(ALICE, BOB, amt(1), [big()], { actAs: [BOB] }));
await mustFail("the same holding twice in inputHoldingCids", transfer(ALICE, BOB, amt(1), [big(), big()]));
await mustFail("admin as sender spends alice's holding", transfer(admin, BOB, amt(1), [big()]), /not owned by sender/i);
await invariants("transfer edges");

// ---- allocation edges --------------------------------------------------------------------------
console.log("-- allocation");
{ const r = ref(); await allocate(ALICE, BOB, amt(1), [(await aliceFree())[0]], r)();
  const a = await findAlloc(r);
  await al([admin, ALICE, BOB], a.contractId, "Allocation_ExecuteTransfer")();
  await mustFail("execute the same allocation twice", al([admin, ALICE, BOB], a.contractId, "Allocation_ExecuteTransfer")); }
{ const r = ref(); await allocate(ALICE, BOB, amt(1), [(await aliceFree())[0]], r)();
  const a = await findAlloc(r);
  await al([ALICE], a.contractId, "Allocation_Withdraw")();
  await mustFail("withdraw the same allocation twice", al([ALICE], a.contractId, "Allocation_Withdraw")); }
{ const H = (await aliceFree())[0]; const r = ref();
  await allocate(ALICE, BOB, amt(1), [H], r)();
  await mustFail("two allocations from the same holding", allocate(ALICE, BOB, amt(1), [H], ref()));
  await al([ALICE], (await findAlloc(r)).contractId, "Allocation_Withdraw")(); }
await mustFail("allocation with an unknown executor", allocate(ALICE, BOB, amt(1), [(await aliceFree())[0]], ref(), { executor: GHOST }));
await mustFail("allocation to an unknown receiver", allocate(ALICE, GHOST, amt(1), [(await aliceFree())[0]], ref()));
{ const r = ref(); await allocate(ALICE, ALICE, amt(1), [(await aliceFree())[0]], r)();
  const a = await findAlloc(r);
  await al([admin, ALICE], a.contractId, "Allocation_ExecuteTransfer")();
  ok("sender == receiver allocation executes", !(await findAlloc(r))); }
{ const H = (await aliceFree()).find((h) => mu(h.createArgument.amount) >= 2); const whole = mu(H.createArgument.amount); const r = ref();
  await allocate(ALICE, BOB, amt(whole), [H], r)();
  const S = await snap();
  ok("allocating a holding's FULL amount locks it all (no change holding)", S.H.some((h) => h.createArgument.lock != null && mu(h.createArgument.amount) === whole));
  await al([ALICE], (await findAlloc(r)).contractId, "Allocation_Withdraw")(); }
await invariants("allocation edges");

// ---- what the issuer (admin) can and cannot do ------------------------------------------------
console.log("-- issuer powers");
const [adm] = await acs(token, admin, T.ADMIN);
const mintTiny = async (to) => { await tpl([admin], T.ADMIN, adm.contractId, "CusdtAdmin_Mint", { recipient: to, amount: amt(1) })(); expected += 1; return free(await snap(), to).find((h) => mu(h.createArgument.amount) === 1); };
{ const tiny = await mintTiny(ALICE);
  await mustFail("admin cannot use the custom Burn on alice's holding", tpl([admin], T.HOLDING, tiny.contractId, "CusdtHolding_Burn"));
  let archived = false;
  try { await tpl([admin], T.HOLDING, tiny.contractId, "Archive")(); archived = true; expected -= 1; } catch (e) { console.log("      Archive rejected: " + short(e).slice(-120)); }
  ok("FINDING: admin CAN still destroy alice's holding with Daml's built-in Archive (admin is a signatory)", archived, archived ? "succeeded: the issuer can burn any balance" : "rejected"); }
await invariants("issuer powers");

// redemption path (the building block of a sell/redeem service): user -> admin, admin accepts, admin burns its own holding
console.log("-- redemption path");
{ const before = supply(await snap());
  await transfer(ALICE, admin, amt(5), [(await aliceFree()).find((h) => mu(h.createArgument.amount) >= 5)])();
  const inst = (await snap()).I.find((i) => i.createArgument.transfer.sender === ALICE && i.createArgument.transfer.receiver === admin);
  await ti(admin, inst.contractId, "TransferInstruction_Accept")();
  const mine = free(await snap(), admin).find((h) => mu(h.createArgument.amount) === 5);
  ok("admin received 5 micro as a normal holding", !!mine);
  await tpl([admin], T.HOLDING, mine.contractId, "CusdtHolding_Burn")(); expected -= 5;
  ok("burning the redeemed holding shrinks supply by exactly 5 micro", supply(await snap()) === before - 5); }
await invariants("redemption path");

await settleAll();
const S = await snap(); await invariants("everything");
console.log(`\nend: supply ${supply(S) / 1e6}, pending ${S.I.length}, allocations ${S.A.length}`);
console.log(`${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
