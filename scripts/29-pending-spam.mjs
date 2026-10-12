// Pending-offer spam, scaled down: N (default 50) 1-micro OFFERS from alice to one receiver without a preapproval.
// Measures what N pending instructions cost the receiver: listing time, ACS payload, registry lookup latency, accept cost.
// NOTE: N < 200 cannot show the >200 ACS-cap block itself (that needs 205); it shows how things scale below the cap.
//   node scripts/29-pending-spam.mjs [N=50]
// Own traffic meter: sums paidTrafficCost of every transaction and aborts past BUDGET (default 280000), Lighthouse is too laggy to rely on.
import { loadEnv } from "./lib.mjs";
import { T, snapshot, supply, checkInvariants } from "./invariants.mjs";
import { amt, IF } from "./ops.mjs";
import { node } from "./nodes.mjs";

const N = Number(process.argv[2] ?? 50), BUDGET = Number(process.env.BUDGET ?? 280_000);
const OURS = loadEnv(".env.testnet");
if (OURS.INSECURE_TLS === "1") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const admin = OURS.CUSDT_ADMIN_PARTY, sfx = admin.split("::")[1], ALICE = `cusdt-alice::${sfx}`, BOB = `cusdt-bob::${sfx}`;
const REGISTRY = process.env.CUSDT_REGISTRY_URL || "https://registry-testnet.mahawallet.xyz";
const PKG = "#cusdt-token", HOLD = `${PKG}:CusdtToken:CusdtHolding`, INSTR = `${PKG}:CusdtToken:CusdtTransferInstruction`, PRE = `${PKG}:CusdtToken:CusdtTransferPreapproval`;
const ours = node(OURS, "ours");
const short = (e) => String(e?.message ?? e).replace(/\s+/g, " ");
const extra = { extraArgs: { context: { values: {} }, meta: { values: {} } } };
const sumH = (hs) => hs.reduce((s, h) => s + Math.round(Number(h.createArgument.amount) * 1e6), 0);
const free = async (p) => (await ours.acs(p, HOLD)).filter((c) => c.createArgument.owner === p && c.createArgument.lock == null);
let pass = 0, fail = 0, bytes = 0, txs = 0;
const ok = (n, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  — " + x : ""}`); };
const meter = (r) => { const c = Number(r?.transaction?.paidTrafficCost ?? 0); bytes += c; txs++; if (bytes > BUDGET) throw new Error(`traffic budget exceeded (${bytes} > ${BUDGET}) after ${txs} txs`); return r; };
const expected = supply(await snapshot(await ours.token(), admin));
const t = (label, f) => async () => { const t0 = Date.now(); const v = await f(); console.log(`      ${label}: ${Date.now() - t0} ms`); return v; };

// receiver: bob unless he has a preapproval (then the offers would be direct transfers)
const RCV = (await ours.acs(BOB, PRE)).length === 0 ? BOB : admin;
if (RCV === admin && (await ours.acs(admin, PRE)).some((p) => p.createArgument.receiver === admin)) { console.log("no receiver without a preapproval; aborting"); process.exit(2); }
console.log(`receiver: ${RCV.split("::")[0]}; offers: ${N}; budget ${BUDGET} bytes; pending before: ${(await ours.acs(admin, INSTR)).length}`);
const pending0 = (await ours.acs(admin, INSTR)).length, r0 = sumH(await free(RCV));

// 1. send N offers sequentially (each spends the previous change holding)
const post = (path, body) => fetch(`${REGISTRY}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const iso = (ms) => new Date(Date.now() + ms).toISOString();
// same as ops.transfer but through submit-and-wait-for-transaction, which reports paidTrafficCost
const offer = async (h) => {
  const tr = { sender: ALICE, receiver: RCV, amount: amt(1), instrumentId: { admin, id: "cUSDT" }, requestedAt: iso(-30_000), executeBefore: iso(3_600_000), inputHoldingCids: [h.contractId], meta: { values: {} } };
  const f = await post("/registry/transfer-instruction/v1/transfer-factory", { choiceArguments: { expectedAdmin: admin, transfer: tr } });
  return ours.tx([ALICE], [{ ExerciseCommand: { templateId: IF.TF, contractId: f.factoryId, choice: "TransferFactory_Transfer", choiceArgument: { expectedAdmin: admin, transfer: tr, extraArgs: { context: f.choiceContext.choiceContextData, meta: { values: {} } } } } }], f.choiceContext.disclosedContracts);
};
let sent = 0, firstErr = "";
const t0 = Date.now();
let errors = 0;
while (sent < N && errors < 6) {
  try {
    const h = (await free(ALICE)).sort((a, b) => Number(b.createArgument.amount) - Number(a.createArgument.amount))[0];
    meter(await offer(h)); sent++;
  } catch (e) {
    if (/budget exceeded/.test(String(e.message))) { firstErr = short(e); break; }
    // a timed-out / dropped send may still have committed: trust the ledger, not the exception
    errors++; firstErr = short(e).slice(-120); await new Promise((r) => setTimeout(r, 6000));
    sent = (await ours.acs(admin, INSTR)).filter((i) => i.createArgument.transfer.sender === ALICE).length - pending0;
  }
}
console.log(`      sent ${sent}/${N} offers in ${((Date.now() - t0) / 1000).toFixed(0)} s; paidTrafficCost total ${bytes} bytes (${txs} txs, avg ${txs ? Math.round(bytes / txs) : 0}/tx)${firstErr ? "; stopped: " + firstErr : ""}`);
ok(`${N} offers sent`, sent === N, firstErr);   // a timed-out send (503) may still have committed: everything below uses the REAL pending list

// 2. what does the receiver see?
const lt = Date.now();
const seen = (await ours.acs(RCV, INSTR)).filter((i) => i.createArgument.transfer.sender === ALICE);
ok("receiver lists all pending offers (>= those acknowledged)", seen.length >= sent, `${seen.length} listed in ${Date.now() - lt} ms`);
const bt = Date.now();
const probe = await fetch(`${REGISTRY}/registry/transfer-instruction/v1/transfer-factory`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ choiceArguments: { expectedAdmin: admin, transfer: { sender: ALICE, receiver: RCV, amount: amt(1), instrumentId: { admin, id: "cUSDT" }, requestedAt: new Date(Date.now() - 3e4).toISOString(), executeBefore: new Date(Date.now() + 36e5).toISOString(), inputHoldingCids: [], meta: { values: {} } } } }) }).then((r) => r.json());
ok("registry still answers `offer` for that receiver with many pending", probe.transferKind === "offer", `${probe.transferKind} in ${Date.now() - bt} ms`);
const a1 = (await ours.acs(ALICE, INSTR)).length;
ok("the SENDER sees them too", a1 >= seen.length, `${a1}`);

// 3. accept them all as the receiver (25 per transaction: shows batch accept; the cost is per command, not per tx), then merge the dust down to 1 holding
let accepted = 0, accErr = "";
const t1 = Date.now(), b1 = bytes;
try { for (let k = 0; k < seen.length; k += 25) { const part = seen.slice(k, k + 25); meter(await ours.tx([RCV], part.map((i) => ({ ExerciseCommand: { templateId: IF.TI, contractId: i.contractId, choice: "TransferInstruction_Accept", choiceArgument: extra } })))); accepted += part.length; } }
catch (e) { accErr = short(e).slice(-200); }
console.log(`      accepted ${accepted}/${seen.length} in ${((Date.now() - t1) / 1000).toFixed(0)} s; ${bytes - b1} bytes (avg ${accepted ? Math.round((bytes - b1) / accepted) : 0}/accept)${accErr ? "; stopped: " + accErr : ""}`);
ok("receiver accepted every offer", accepted === seen.length, accErr);
ok("receiver holds the sum", sumH(await free(RCV)) === r0 + accepted);
{ const hs = await free(RCV); if (hs.length > 1) { try { meter(await ours.tx([RCV], [{ ExerciseCommand: { templateId: HOLD, contractId: hs[0].contractId, choice: "CusdtHolding_Merge", choiceArgument: { otherCids: hs.slice(1).map((h) => h.contractId) } } }])); console.log(`      merged ${hs.length} holdings in ONE tx`); } catch (e) { console.log("      merge failed: " + short(e).slice(-160)); } } }
ok("no pending instructions left", (await ours.acs(admin, INSTR)).length === 0);
const v = checkInvariants(await snapshot(await ours.token(), admin), expected);
ok("conservation", v.length === 0, v.join("; "));
console.log(`total traffic metered: ${bytes} bytes in ${txs} txs`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
