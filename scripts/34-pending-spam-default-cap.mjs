// 205 pending offers to a receiver on a node with the DEFAULT 200-element list cap (cryptolampung, party "dave").
// All traffic is paid by OUR node (mint + offers + withdraws); the cap node only answers reads. Shows what the receiver's wallet sees.
//   node scripts/34-pending-spam-default-cap.mjs [N=205]
// Cleanup is done by the SENDER (alice withdraws every offer, merges the returned micro, burns exactly the minted amount), so supply ends where it began.
import { loadEnv } from "./lib.mjs";
import { T, snapshot, supply, checkInvariants } from "./invariants.mjs";
import { amt, IF } from "./ops.mjs";
import { node, sleep } from "./nodes.mjs";
import { wsActiveContracts } from "./31-ws-active-contracts.mjs";

const N = Number(process.argv[2] ?? 205), BUDGET = Number(process.env.BUDGET ?? 900_000);
const OURS = loadEnv(".env.testnet"), CL = loadEnv(".env.cl");
if (OURS.INSECURE_TLS === "1" || CL.INSECURE_TLS === "1") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const ours = node(OURS, "ours"), cl = node(CL, "cl");
const admin = OURS.CUSDT_ADMIN_PARTY, sfx = admin.split("::")[1], ALICE = `cusdt-alice::${sfx}`, DAVE = CL.CUSDT_CL_DAVE;
const REGISTRY = process.env.CUSDT_REGISTRY_URL || "https://registry-testnet.cryptolampung.space";
const HOLD = "#cusdt-token:CusdtToken:CusdtHolding";
const short = (e) => String(e?.message ?? e).replace(/\s+/g, " ");
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const extra = { extraArgs: { context: { values: {} }, meta: { values: {} } } };
const mu = (c) => Math.round(Number(c.createArgument.amount) * 1e6);
const chunks = (a, k) => Array.from({ length: Math.ceil(a.length / k) }, (_, i) => a.slice(i * k, i * k + k));
let pass = 0, fail = 0, bytes = 0, txs = 0;
const ok = (m, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}  ${m}${x ? "  — " + x : ""}`); };
const metered = async (actAs, commands, disclosed = []) => {
  const r = await ours.tx(actAs, commands, disclosed); bytes += Number(r?.transaction?.paidTrafficCost ?? 0); txs++;
  if (bytes > BUDGET) throw Object.assign(new Error(`budget exceeded (${bytes} > ${BUDGET})`), { budget: true }); return r;
};
const post = (path, body) => fetch(`${REGISTRY}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const free = async () => (await ours.acs(ALICE, HOLD)).filter((c) => c.createArgument.owner === ALICE && c.createArgument.lock == null);
const pend = async () => (await ours.acs(admin, T.INSTR)).filter((i) => i.createArgument.transfer.sender === ALICE && i.createArgument.transfer.receiver === DAVE);

const S0 = await snapshot(await ours.token(), admin), expected0 = supply(S0), before = (await pend()).length;
console.log(`N=${N}, budget ${BUDGET} B; supply ${expected0 / 1e6}; pending alice->dave before: ${before}; registry ${REGISTRY}`);
const minted = [];
async function cleanup() {
  console.log("-- cleanup (sender side)");
  try {
    const left = await pend();
    for (const part of chunks(left, 25)) await metered([ALICE], part.map((i) => ({ ExerciseCommand: { templateId: IF.TI, contractId: i.contractId, choice: "TransferInstruction_Withdraw", choiceArgument: extra } })));
    await sleep(4000);
    let hs = await free();
    while (hs.length > 1) { const b = hs.slice(0, 100); await metered([ALICE], [{ ExerciseCommand: { templateId: HOLD, contractId: b[0].contractId, choice: "CusdtHolding_Merge", choiceArgument: { otherCids: b.slice(1).map((h) => h.contractId) } } }]); hs = await free(); }
    const extraMu = supply(await snapshot(await ours.token(), admin)) - expected0;
    if (extraMu > 0 && hs[0] && mu(hs[0]) > extraMu) {
      const r = await metered([ALICE], [{ ExerciseCommand: { templateId: HOLD, contractId: hs[0].contractId, choice: "CusdtHolding_Split", choiceArgument: { splitAmount: amt(extraMu) } } }]);
      const ex = r.transaction.events.find((e) => e.ExercisedEvent?.choice === "CusdtHolding_Split")?.ExercisedEvent?.exerciseResult;
      const cid = Array.isArray(ex) ? ex[0] : (ex?._1 ?? ex?.["_1"]);
      if (cid) await metered([ALICE], [{ ExerciseCommand: { templateId: HOLD, contractId: cid, choice: "CusdtHolding_Burn", choiceArgument: {} } }]); else console.log("      could not read the split result: burn " + extraMu + " micro by hand");
    }
  } catch (e) { console.log("cleanup issue: " + short(e).slice(-200)); }
}

try {
  const [adm] = await ours.acs(admin, T.ADMIN);
  for (let left = N; left > 0;) {
    const k = Math.min(50, left);
    const r = await metered([admin], Array.from({ length: k }, () => ({ ExerciseCommand: { templateId: T.ADMIN, contractId: adm.contractId, choice: "CusdtAdmin_Mint", choiceArgument: { recipient: ALICE, amount: amt(1) } } })));
    for (const e of r.transaction.events) if (e.ExercisedEvent?.choice === "CusdtAdmin_Mint") minted.push(e.ExercisedEvent.exerciseResult);
    left -= k;
  }
  ok("minted N x 1 micro to alice", minted.length === N, `metered ${bytes} B`);
  const tr = (cid) => ({ sender: ALICE, receiver: DAVE, amount: amt(1), instrumentId: { admin, id: "YAP" }, requestedAt: iso(-30_000), executeBefore: iso(7_200_000), inputHoldingCids: [cid], meta: { values: {} } });
  const f = await post("/registry/transfer-instruction/v1/transfer-factory", { choiceArguments: { expectedAdmin: admin, transfer: tr(minted[0]) } });
  ok("registry answers `offer` for dave", f.transferKind === "offer", f.transferKind);
  for (const part of chunks(minted, 50)) await metered([ALICE], part.map((cid) => ({ ExerciseCommand: { templateId: IF.TF, contractId: f.factoryId, choice: "TransferFactory_Transfer", choiceArgument: { expectedAdmin: admin, transfer: tr(cid), extraArgs: { context: f.choiceContext.choiceContextData, meta: { values: {} } } } } })), f.choiceContext.disclosedContracts);
  await sleep(8000);
  const total = before + N, seen = (await pend()).length;
  ok("the issuer's view (admin on our node) shows every pending offer", seen === total, `${seen} of ${total}`);
  // the receiver's wallet on the node with the default cap
  let httpErr = null, httpN = null; const t0 = Date.now();
  try { httpN = (await cl.acs(DAVE, T.INSTR)).filter((i) => i.createArgument.transfer.sender === ALICE).length; } catch (e) { httpErr = short(e); }
  if (httpErr) ok("dave's HTTP list is refused above 200 (default cap) — the wallet on that node goes blind", /MAXIMUM_LIST_ELEMENTS/.test(httpErr), httpErr.match(/JSON_API_[A-Z_]+/)?.[0] ?? httpErr.slice(-140));
  else ok("dave's HTTP list returned everything (cap not enforced here?)", httpN === total, `${httpN} in ${Date.now() - t0} ms`);
  let wsMsg; try { const ws = await wsActiveContracts(cl, CL, DAVE, T.INSTR, { timeoutMs: 20_000 }); wsMsg = `websocket returned ${ws.filter((i) => i.createArgument.transfer.sender === ALICE).length}`; } catch (e) { wsMsg = "websocket failed: " + short(e).slice(0, 120); }
  console.log("      " + wsMsg + "   (the cap node's nginx has no websocket upgrade patch yet)");
  const f2 = await post("/registry/transfer-instruction/v1/transfer-factory", { choiceArguments: { expectedAdmin: admin, transfer: tr(minted[0]) } });
  ok("registry lookups for dave keep working while the pile is pending", f2.transferKind === "offer");
} catch (e) { fail++; console.log(`FAIL  threw: ${short(e).slice(-300)}`); }
finally { await cleanup(); }

const left = (await pend()).length;
ok("no pending offers left", left === before, `${left}`);
const v = checkInvariants(await snapshot(await ours.token(), admin), expected0);
ok("supply back to the start, invariants hold", v.length === 0, v.join("; "));
console.log(`traffic metered on OUR node: ${bytes} bytes in ${txs} txs (the cap node paid nothing)\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
