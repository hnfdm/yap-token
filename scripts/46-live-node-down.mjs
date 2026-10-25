// LIVE resilience probe: what happens to a governed YAP transaction while one of the two hosting nodes (t2) is down?
//   1. stop t2 (decman first, then ./stop.sh), 2. node scripts/46-live-node-down.mjs, 3. start t2 again (./start.sh, then decman) while it runs.
// The transaction is a vesting claim of the staking pool (no registry, one command, needs BOTH participants to confirm). Expected: it does
// not complete while t2 is down and nothing is lost: once t2 is back it either completes or is rejected cleanly, never half-applied.
import { loadEnv } from "./lib.mjs";
import { node, sleep } from "./nodes.mjs";

const E = loadEnv(".env.testnet"); if (E.INSECURE_TLS === "1") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const n = node(E, "t1");
const GOV = E.CUSDT_GOV_PARTY ?? "cusdt-gov::12205fb8f032bfcfe6ae4ae3a7625629fe9065668ee529e3a785691e1cdce5022c2b";
const POOL = E.YAP_POOL_STAKING;
const VEST = "#yap-token:YapToken:YapVesting", HOLD = "#yap-token:YapToken:YapHolding";
const mu = (x) => Math.round(Number(x) * 1e6);
const vest = async () => (await n.acs(GOV, VEST)).filter((c) => c.createArgument.beneficiary === POOL);
const supply = async () => (await n.acs(GOV, HOLD)).reduce((s, c) => s + mu(c.createArgument.amount), 0);
const v0 = (await vest())[0], claimed0 = mu(v0.createArgument.claimed), s0 = await supply();
console.log(`start: claimed ${claimed0 / 1e6}, supply ${s0 / 1e6}; submitting the claim (client gives up waiting after 90 s)`);
const t0 = Date.now();
const body = { commands: { commands: [{ ExerciseCommand: { templateId: VEST, contractId: v0.contractId, choice: "YapVesting_Claim", choiceArgument: {} } }], commandId: `down-${Date.now()}`, actAs: [POOL], readAs: [POOL] },
  transactionFormat: { transactionShape: "TRANSACTION_SHAPE_LEDGER_EFFECTS", eventFormat: { filtersByParty: { [POOL]: {} }, verbose: true } } };
const call = n.ledger("/v2/commands/submit-and-wait-for-transaction", { method: "POST", json: body }).then(() => "completed", (e) => "error: " + String(e.message).replace(/\s+/g, " ").slice(0, 300));
const first = await Promise.race([call, sleep(90_000).then(() => "no answer after 90 s")]);
console.log(`after ${Math.round((Date.now() - t0) / 1000)} s: ${first}`);
console.log("now start t2 again (./start.sh, then docker start decman); polling for up to 8 minutes");
let last = "";
for (let i = 0; i < 96; i++) {
  await sleep(5000);
  let st; try { const v = (await vest())[0]; st = v ? mu(v.createArgument.claimed) > claimed0 ? "CLAIMED" : "unchanged" : "gone"; } catch (e) { st = "ledger unreachable"; }
  if (st !== last) { console.log(`+${Math.round((Date.now() - t0) / 1000)} s: vesting ${st}`); last = st; }
  if (st === "CLAIMED") break;
}
const s1 = await supply();
console.log(`supply ${s1 / 1e6} (${s1 === s0 ? "unchanged, OK" : "CHANGED"}); final state: ${last}; first answer: ${first}`);
