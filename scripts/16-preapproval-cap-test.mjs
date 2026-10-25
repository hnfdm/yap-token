// What happens to direct transfers when the admin has 200 / 201+ TransferPreapprovals?
// The registry finds a receiver's preapproval by scanning the admin's ACS, and the Ledger JSON API caps a
// (non-streaming) ACS answer at 200 elements. Expected: no 500s; past the cap the registry degrades to "offer".
// The junk preapprovals (for cusdt-alice) are archived again in `finally`, using the ids captured at creation
// (past the cap the admin can no longer LIST them).
import { getToken, ledger, acs, need, PKG } from "./lib.mjs";
import { T } from "./invariants.mjs";

const admin = need("CUSDT_ADMIN_PARTY");
const suffix = admin.split("::")[1];
const ALICE = (process.env.CUSDT_ALICE || `cusdt-alice::${suffix}`), BOB = (process.env.CUSDT_BOB || `cusdt-bob::${suffix}`);
const registry = process.env.CUSDT_REGISTRY_URL || "http://localhost:8787";
const token = await getToken();
const iso = (ms) => new Date(Date.now() + ms).toISOString();

const tx = (commands) => ledger(token, "/v2/commands/submit-and-wait-for-transaction", { method: "POST", json: {
  commands: { commands, commandId: `cap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, actAs: [admin], readAs: [admin] },
  transactionFormat: { transactionShape: "TRANSACTION_SHAPE_LEDGER_EFFECTS", eventFormat: { filtersByParty: { [admin]: {} }, verbose: true } } } });
const adminCid = async () => (await acs(token, admin, T.ADMIN))[0].contractId;
let traffic = [];
async function createPre(receiver, n) {
  const out = []; const adm = await adminCid();
  while (n > 0) {
    const k = Math.min(50, n);
    const r = await tx(Array.from({ length: k }, () => ({ ExerciseCommand: { templateId: T.ADMIN, contractId: adm, choice: "YapAdmin_CreatePreapproval", choiceArgument: { receiver } } })));
    for (const e of r.transaction.events) if (e.ExercisedEvent?.choice === "YapAdmin_CreatePreapproval") out.push(e.ExercisedEvent.exerciseResult);
    traffic.push({ op: `create ${k} preapprovals`, cost: r.transaction.paidTrafficCost });
    n -= k;
  }
  return out;
}
async function archive(cids) {
  for (let i = 0; i < cids.length; i += 50) {
    const r = await tx(cids.slice(i, i + 50).map((c) => ({ ExerciseCommand: { templateId: T.PRE, contractId: c, choice: "Archive", choiceArgument: {} } })));
    traffic.push({ op: `archive ${Math.min(50, cids.length - i)} preapprovals`, cost: r.transaction.paidTrafficCost });
  }
}
async function probe() {   // what the registry answers for alice -> bob right now
  const t = { sender: ALICE, receiver: BOB, amount: "0.0000010000", instrumentId: { admin, id: "YAP" }, requestedAt: iso(-30_000), executeBefore: iso(3_600_000), inputHoldingCids: [], meta: { values: {} } };
  const r = await fetch(`${registry}/registry/transfer-instruction/v1/transfer-factory`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ choiceArguments: { expectedAdmin: admin, transfer: t } }) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, kind: j.transferKind ?? j.error };
}
const countPre = async () => { try { return (await acs(token, admin, T.PRE)).length; } catch (e) { return `ERROR: ${String(e.message).replace(/\s+/g, " ").slice(0, 160)}`; } };

let pass = 0, fail = 0;
const ok = (n, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  — " + x : ""}`); };

const junk = []; let bobPre = null;
try {
  // bob must have a preapproval so that "direct" is the baseline
  if (!(await acs(token, admin, T.PRE)).some((c) => c.createArgument.receiver === BOB)) bobPre = (await createPre(BOB, 1))[0];
  const n0 = await countPre();
  console.log(`start: ${n0} preapprovals at the admin`);
  let p = await probe();
  ok("baseline: bob has a preapproval -> registry says direct", p.status === 200 && p.kind === "direct", `${p.status} ${p.kind}`);

  await junk.push(...(await createPre(ALICE, 200 - n0)));
  console.log(`  (added ${junk.length} junk preapprovals, total should be 200 now)`);
  const c200 = await countPre();
  p = await probe();
  ok("at exactly 200: still fully functional", c200 === 200 && p.status === 200 && p.kind === "direct", `count ${c200}, ${p.status} ${p.kind}`);

  junk.push(...(await createPre(ALICE, 1)));
  const c201 = await countPre();
  console.log(`  raw admin ACS with 201 preapprovals -> ${c201}`);
  p = await probe();
  ok("at 201: registry does NOT error (no 500)", p.status === 200, `${p.status} ${p.kind}`);
  // Two configurations exist: the DEFAULT list limit (200: the raw ACS is refused and the registry falls back to an offer) and a RAISED
  // limit (ADDITIONAL_CONFIG_LIST_LIMIT, as on t1: the raw ACS returns all 201 and the registry still finds the preapproval).
  const capped = typeof c201 === "string";
  console.log(`  this node has ${capped ? "the DEFAULT 200-element list limit" : "a RAISED list limit"}`);
  if (capped) {
    ok("at 201 (default limit): it degrades to offer (bob's preapproval is not found)", p.kind === "offer", `kind=${p.kind}`);
    ok("the admin ACS really is capped at 201", /MAXIMUM_LIST_ELEMENTS|413|too many|limit/i.test(c201), String(c201).slice(0, 110));
  } else {
    ok("at 201 (raised limit): the registry still finds bob's preapproval", p.kind === "direct", `kind=${p.kind}`);
    ok("the raw admin ACS returns all 201 contracts", c201 === 201, `count ${c201}`);
  }
} finally {
  if (bobPre) { /* we created bob's preapproval only for the baseline; leave state as found */ junk.push(bobPre); }
  if (junk.length) { await archive(junk); }
  const back = await countPre();
  ok("cleanup: junk archived, ACS readable again", typeof back === "number", `${back} preapprovals left`);
  const p2 = await probe();
  console.log(`after cleanup: registry says ${p2.status} ${p2.kind}`);
  console.log("traffic (paidTrafficCost per transaction):", traffic.map((t) => `${t.op}: ${t.cost}`).join(" | "));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}
