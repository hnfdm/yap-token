// How long are transfers broken after the factory singleton is rotated? The registry caches the factory (blob + cid) for 30 s.
// Rotates YapTransferFactory (create new, archive old), then keeps asking the registry and retrying a 1-micro SELF transfer
// (alice -> alice, no pending offer left behind) until it works. Reports the stale window. All on our node, small.
//   node scripts/28-stale-factory-window.mjs
import { loadEnv } from "./lib.mjs";
import { T, snapshot, supply, checkInvariants } from "./invariants.mjs";
import { makeOps, amt } from "./ops.mjs";
import { node, sleep } from "./nodes.mjs";

const OURS = loadEnv(".env.testnet");
if (OURS.INSECURE_TLS === "1") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const admin = OURS.CUSDT_ADMIN_PARTY, sfx = admin.split("::")[1], ALICE = (process.env.CUSDT_ALICE || `cusdt-alice::${sfx}`);
const REGISTRY = process.env.CUSDT_REGISTRY_URL || "https://registry-testnet.cryptolampung.space";
const TFT = "#yap-token:YapToken:YapTransferFactory", HOLD = "#yap-token:YapToken:YapHolding";
const ours = node(OURS, "ours");
const short = (e) => String(e?.message ?? e).replace(/\s+/g, " ");
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  — " + x : ""}`); };
const expected = supply(await snapshot(await ours.token(), admin));
const probe = () => fetch(`${REGISTRY}/registry/transfer-instruction/v1/transfer-factory`, { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ choiceArguments: { expectedAdmin: admin, transfer: { sender: ALICE, receiver: ALICE, amount: amt(1), instrumentId: { admin, id: "YAP" }, requestedAt: new Date(Date.now() - 3e4).toISOString(), executeBefore: new Date(Date.now() + 36e5).toISOString(), inputHoldingCids: [], meta: { values: {} } } } }) }).then((r) => r.json());

const warm = await probe(); await probe();
console.log(`registry factory (cache warm): ${warm.factoryId.slice(0, 16)}…`);
const [old] = await ours.acs(admin, TFT);
ok("exactly one transfer factory before", !!old && (await ours.acs(admin, TFT)).length === 1 && old.contractId === warm.factoryId);

await ours.tx([admin], [{ CreateCommand: { templateId: TFT, createArguments: { admin } } }]);
const fresh = (await ours.acs(admin, TFT)).find((c) => c.contractId !== old.contractId);
await ours.tx([admin], [{ ExerciseCommand: { templateId: TFT, contractId: old.contractId, choice: "Archive", choiceArgument: {} } }]);
const t0 = Date.now(); console.log(`rotated at t=0: old ${old.contractId.slice(0, 12)}… archived, new ${fresh.contractId.slice(0, 12)}…`);

let firstOk = null, failed = 0, newSeenAt = null, lastErr = "";
while (Date.now() - t0 < 90_000) {
  const p = await probe(); const sec = (Date.now() - t0) / 1000;
  if (p.factoryId === fresh.contractId && newSeenAt === null) newSeenAt = sec;
  const o = makeOps({ token: await ours.token(), admin, registry: REGISTRY });
  const h = (await ours.acs(ALICE, HOLD)).filter((c) => c.createArgument.owner === ALICE && c.createArgument.lock == null).sort((a, b) => Number(b.createArgument.amount) - Number(a.createArgument.amount))[0];
  try { await o.transfer(ALICE, ALICE, amt(1), [h])(); firstOk = sec; break; }
  catch (e) { failed++; lastErr = short(e); console.log(`  t=${sec.toFixed(1)}s  registry answers ${p.factoryId === fresh.contractId ? "NEW" : "OLD"} factory; transfer failed: ${lastErr.slice(-110)}`); await sleep(2000); }
}
ok("transfers work again by themselves (no registry restart needed)", firstOk !== null, firstOk !== null ? `first success after ${firstOk.toFixed(1)} s, ${failed} failed attempt(s)` : `still failing after 90 s: ${lastErr.slice(-160)}`);
ok("stale window is within the 30 s cache TTL (+ ledger lag)", firstOk !== null && firstOk <= 40, firstOk !== null ? `${firstOk.toFixed(1)} s` : "");
console.log(`      registry served the NEW factory from t=${newSeenAt?.toFixed(1) ?? "never"} s`);
ok("exactly one transfer factory afterwards", (await ours.acs(admin, TFT)).length === 1);
const v = checkInvariants(await snapshot(await ours.token(), admin), expected);
ok("conservation (self transfer moved nothing net)", v.length === 0, v.join("; "));
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
