// 205 pending OFFERS to one receiver (above the 200 list cap): can the receiver still see and accept all of them?
//   node scripts/33-pending-spam-205.mjs [N=205]
// Cheap by batching: the admin mints N holdings of 1 micro to alice (50 per tx), alice sends one offer per holding (50 per tx), bob accepts them
// (25 per tx), merges, then splits exactly the minted micro off and burns it (supply is back to the start). Own traffic meter (paidTrafficCost).
// Reads the pending list THREE ways: HTTP (cap depends on the node's http-list-max-elements-limit), websocket stream, registry lookup latency.
import { loadEnv } from "./lib.mjs";
import { T, snapshot, supply, checkInvariants } from "./invariants.mjs";
import { amt, IF } from "./ops.mjs";
import { node, sleep } from "./nodes.mjs";
import { wsActiveContracts } from "./31-ws-active-contracts.mjs";

const N = Number(process.argv[2] ?? 205), BUDGET = Number(process.env.BUDGET ?? 700_000);
const E = loadEnv(".env.testnet"); if (E.INSECURE_TLS === "1") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const n = node(E, "ours"), admin = E.CUSDT_ADMIN_PARTY, sfx = admin.split("::")[1], ALICE = (process.env.CUSDT_ALICE || `cusdt-alice::${sfx}`), BOB0 = (process.env.CUSDT_BOB || `cusdt-bob::${sfx}`);
const REGISTRY = process.env.CUSDT_REGISTRY_URL || "https://registry-testnet.cryptolampung.space";
const HOLD = "#yap-token:YapToken:YapHolding", PRE = "#yap-token:YapToken:YapTransferPreapproval";
const short = (e) => String(e?.message ?? e).replace(/\s+/g, " ");
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const extra = { extraArgs: { context: { values: {} }, meta: { values: {} } } };
const mu = (c) => Math.round(Number(c.createArgument.amount) * 1e6);
let pass = 0, fail = 0, bytes = 0, txs = 0;
const ok = (m, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}  ${m}${x ? "  — " + x : ""}`); };
const metered = async (actAs, commands, disclosed = []) => {
  const r = await n.tx(actAs, commands, disclosed); bytes += Number(r?.transaction?.paidTrafficCost ?? 0); txs++;
  if (bytes > BUDGET) throw Object.assign(new Error(`budget exceeded (${bytes} > ${BUDGET})`), { budget: true }); return r;
};
const post = (path, body) => fetch(`${REGISTRY}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const free = async (p) => (await n.acs(p, HOLD)).filter((c) => c.createArgument.owner === p && c.createArgument.lock == null);
// receiver: bob unless he has a preapproval (then the offers would be direct): the admin party as receiver also works
const BOB = (await n.acs(BOB0, PRE)).length === 0 ? BOB0 : admin;
const T0 = await n.token();
const S0 = await snapshot(T0, admin), expected0 = supply(S0);
const pend = async () => (await n.acs(admin, T.INSTR)).filter((i) => i.createArgument.transfer.sender === ALICE && i.createArgument.transfer.receiver === BOB);
console.log(`N=${N}, budget ${BUDGET} bytes; supply ${expected0 / 1e6}; pending alice->bob before: ${(await pend()).length}`);
if (BOB === admin && (await n.acs(admin, PRE)).some((p) => p.createArgument.receiver === admin)) { console.log("no receiver without a preapproval. Aborting."); process.exit(2); }
console.log("receiver:", BOB.split("::")[0]);
const before = (await pend()).length;
const chunks = (a, k) => Array.from({ length: Math.ceil(a.length / k) }, (_, i) => a.slice(i * k, i * k + k));
const minted = [];

async function cleanup() {
  console.log("-- cleanup");
  try {
    const left = await pend();
    for (const part of chunks(left, 25)) await metered([BOB], part.map((i) => ({ ExerciseCommand: { templateId: IF.TI, contractId: i.contractId, choice: "TransferInstruction_Accept", choiceArgument: extra } })));
    await sleep(3000);
    for (const p of [BOB, ALICE]) {          // consolidate, then burn whatever supply we added
      let hs = await free(p);
      while (hs.length > 1) { const batch = hs.slice(0, 100); await metered([p], [{ ExerciseCommand: { templateId: HOLD, contractId: batch[0].contractId, choice: "YapHolding_Merge", choiceArgument: { otherCids: batch.slice(1).map((h) => h.contractId) } } }]); hs = await free(p); }
    }
    const extraMu = supply(await snapshot(await n.token(), admin)) - expected0;
    if (extraMu > 0) for (const p of [BOB, ALICE]) {
      const [h] = await free(p); if (!h || mu(h) <= extraMu) continue;
      const r = await metered([p], [{ ExerciseCommand: { templateId: HOLD, contractId: h.contractId, choice: "YapHolding_Split", choiceArgument: { splitAmount: amt(extraMu) } } }]);
      const ex = r.transaction.events.find((e) => e.ExercisedEvent?.choice === "YapHolding_Split")?.ExercisedEvent?.exerciseResult;
      const cid = Array.isArray(ex) ? ex[0] : (ex?._1 ?? ex?.["_1"]);
      if (!cid) { console.log("      could not read the split result; burn the " + extraMu + " micro by hand"); break; }
      await metered([p], [{ ExerciseCommand: { templateId: HOLD, contractId: cid, choice: "YapHolding_Burn", choiceArgument: {} } }]);
      break;
    }
  } catch (e) { console.log("cleanup issue: " + short(e).slice(-200)); }
}

try {
  // 1. mint N x 1 micro to alice
  const [adm] = await n.acs(admin, T.ADMIN);
  for (let left = N; left > 0;) {
    const k = Math.min(50, left);
    const r = await metered([admin], Array.from({ length: k }, () => ({ ExerciseCommand: { templateId: T.ADMIN, contractId: adm.contractId, choice: "YapAdmin_Mint", choiceArgument: { recipient: ALICE, amount: amt(1) } } })));
    for (const e of r.transaction.events) if (e.ExercisedEvent?.choice === "YapAdmin_Mint") minted.push(e.ExercisedEvent.exerciseResult);
    left -= k;
  }
  console.log(`minted ${minted.length} x 1 micro to alice (metered ${bytes} B)`);
  ok("minted exactly N holdings", minted.length === N);

  // 2. one offer per holding, 50 per tx
  const tr = (cid) => ({ sender: ALICE, receiver: BOB, amount: amt(1), instrumentId: { admin, id: "YAP" }, requestedAt: iso(-30_000), executeBefore: iso(7_200_000), inputHoldingCids: [cid], meta: { values: {} } });
  const f = await post("/registry/transfer-instruction/v1/transfer-factory", { choiceArguments: { expectedAdmin: admin, transfer: tr(minted[0]) } });
  ok("registry answers `offer`", f.transferKind === "offer", f.transferKind);
  const t1 = Date.now();
  for (const part of chunks(minted, 50)) {
    await metered([ALICE], part.map((cid) => ({ ExerciseCommand: { templateId: IF.TF, contractId: f.factoryId, choice: "TransferFactory_Transfer", choiceArgument: { expectedAdmin: admin, transfer: tr(cid), extraArgs: { context: f.choiceContext.choiceContextData, meta: { values: {} } } } } })), f.choiceContext.disclosedContracts);
  }
  console.log(`sent ${minted.length} offers in ${chunks(minted, 50).length} txs, ${((Date.now() - t1) / 1000).toFixed(0)} s; metered ${bytes} B so far`);
  await sleep(5000);

  // 3. what does the receiver see?
  const total = before + N;
  const th = Date.now(); let httpN, httpErr = null; try { httpN = (await n.acs(BOB, T.INSTR)).filter((i) => i.createArgument.transfer.sender === ALICE).length; } catch (e) { httpErr = short(e); }
  if (httpErr) ok("HTTP list for the receiver (default 200 cap)", /MAXIMUM_LIST_ELEMENTS/.test(httpErr), httpErr.match(/JSON_API_[A-Z_]+/)?.[0] ?? httpErr.slice(-120));
  else ok("HTTP list for the receiver returns every pending offer (raised limit)", httpN === total, `${httpN} of ${total} in ${Date.now() - th} ms`);
  const tw = Date.now(); const viaWs = (await wsActiveContracts(n, E, BOB, T.INSTR)).filter((i) => i.createArgument.transfer.sender === ALICE);
  ok("websocket stream returns every pending offer", viaWs.length === total, `${viaWs.length} of ${total} in ${Date.now() - tw} ms`);
  const tr2 = Date.now(); const f2 = await post("/registry/transfer-instruction/v1/transfer-factory", { choiceArguments: { expectedAdmin: admin, transfer: tr(minted[0]) } });
  ok("registry lookup still fast and correct with the pile pending", f2.transferKind === "offer" && Date.now() - tr2 < 3000, `${f2.transferKind} in ${Date.now() - tr2} ms`);
  const aliceView = (await n.acs(ALICE, T.INSTR)).length; console.log(`      alice (sender) HTTP list: ${aliceView}`);
  ok("conservation with the offers pending", checkInvariants(await snapshot(await n.token(), admin), expected0 + N).length === 0);

  // 4. accept them all, 25 per tx
  const ta = Date.now(), b0 = bytes; let accepted = 0;
  const all = viaWs.length ? viaWs : await pend();
  for (const part of chunks(all, 25)) { await metered([BOB], part.map((i) => ({ ExerciseCommand: { templateId: IF.TI, contractId: i.contractId, choice: "TransferInstruction_Accept", choiceArgument: extra } }))); accepted += part.length; }
  console.log(`      accepted ${accepted} in ${((Date.now() - ta) / 1000).toFixed(0)} s, ${bytes - b0} B (avg ${Math.round((bytes - b0) / Math.max(1, accepted))} B per accept)`);
  ok("bob accepted every offer", accepted === total);
  await sleep(4000);
  const hs = await free(BOB);
  console.log(`      bob now holds ${hs.length} holdings`);
} catch (e) { fail++; console.log(`FAIL  threw: ${short(e).slice(-300)}`); }
finally { await cleanup(); }

const left = (await pend()).length;
ok("no pending offers left", left === before, `${left}`);
const v = checkInvariants(await snapshot(await n.token(), admin), expected0);
ok("supply back to the start, invariants hold", v.length === 0, v.join("; "));
console.log(`traffic metered: ${bytes} bytes in ${txs} txs\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
