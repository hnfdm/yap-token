// Proof that the WEBSOCKET stream is not subject to the 200-element cap that the HTTP list endpoint has.
// Creates 205 junk preapprovals (for cusdt-alice, so bob's direct-transfer lookup is unaffected), lists them both ways, archives them again
// using the captured ids (past the cap the admin cannot LIST them over HTTP). Own traffic meter.
//   node scripts/32-ws-beats-the-cap.mjs [count=205]
import { loadEnv } from "./lib.mjs";
import { T, snapshot, supply, checkInvariants } from "./invariants.mjs";
import { node } from "./nodes.mjs";
import { wsActiveContracts } from "./31-ws-active-contracts.mjs";

const COUNT = Number(process.argv[2] ?? 205), BUDGET = Number(process.env.BUDGET ?? 200_000);
const E = loadEnv(".env.testnet"); if (E.INSECURE_TLS === "1") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const n = node(E, "ours"), admin = E.CUSDT_ADMIN_PARTY, ALICE = `cusdt-alice::${admin.split("::")[1]}`;
let pass = 0, fail = 0, bytes = 0;
const ok = (m, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}  ${m}${x ? "  — " + x : ""}`); };
const meter = (r) => { bytes += Number(r?.transaction?.paidTrafficCost ?? 0); if (bytes > BUDGET) throw new Error(`budget exceeded: ${bytes}`); return r; };
const expected = supply(await snapshot(await n.token(), admin));
const created = [];
try {
  const before = (await wsActiveContracts(n, E, admin, T.PRE)).length;
  const [adm] = await n.acs(admin, T.ADMIN);
  for (let left = COUNT; left > 0;) {
    const k = Math.min(50, left);
    const r = meter(await n.tx([admin], Array.from({ length: k }, () => ({ ExerciseCommand: { templateId: T.ADMIN, contractId: adm.contractId, choice: "CusdtAdmin_CreatePreapproval", choiceArgument: { receiver: ALICE } } }))));
    for (const e of r.transaction.events) if (e.ExercisedEvent?.choice === "CusdtAdmin_CreatePreapproval") created.push(e.ExercisedEvent.exerciseResult);
    left -= k;
  }
  console.log(`created ${created.length} junk preapprovals (metered ${bytes} bytes); existing before: ${before}`);
  let httpErr = null, httpN = null; try { httpN = (await n.acs(admin, T.PRE)).length; } catch (e) { httpErr = String(e.message); }
  ok("HTTP list is refused above 200", !!httpErr && /MAXIMUM_LIST_ELEMENTS/.test(httpErr), httpErr ? httpErr.match(/JSON_API_[A-Z_]+/)?.[0] : `returned ${httpN}`);
  const t0 = Date.now(); const viaWs = await wsActiveContracts(n, E, admin, T.PRE, { blob: true });
  ok("websocket stream returns ALL of them", viaWs.length === before + COUNT, `${viaWs.length} contracts in ${Date.now() - t0} ms (expected ${before + COUNT})`);
  ok("every created id is in the stream", created.every((c) => viaWs.some((x) => x.contractId === c)));
  ok("stream payload carries what the registry needs (blob + receiver)", viaWs.every((x) => x.createdEventBlob && x.createArgument?.receiver));
} finally {
  for (let i = 0; i < created.length; i += 50) await n.tx([admin], created.slice(i, i + 50).map((c) => ({ ExerciseCommand: { templateId: T.PRE, contractId: c, choice: "Archive", choiceArgument: {} } }))).then(meter).catch((e) => console.log("archive issue: " + String(e.message).slice(-160)));
}
const after = (await wsActiveContracts(n, E, admin, T.PRE)).length;
ok("junk preapprovals archived again", !(await wsActiveContracts(n, E, admin, T.PRE)).some((x) => created.includes(x.contractId)), `${after} preapprovals left`);
ok("conservation", checkInvariants(await snapshot(await n.token(), admin), expected).length === 0);
console.log(`traffic metered: ${bytes} bytes\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
