// LIVE check of YapVesting_Claim on the governed YAP instance (admin = cusdt-gov, 2-of-2 over t1 + t2): the airdrop pool claims what has
// vested so far. No governance vote is needed (the beneficiary claims; the admin's authority comes from the contract). Both participants
// still have to confirm the transaction, so this also proves the vesting path across two nodes. Supply must stay exactly 100,000,000.
//   node scripts/45-live-vesting-claim.mjs        (.env.testnet = t1; ~10 s, no human steps; the claim is real and not reversible)
import { loadEnv } from "./lib.mjs";
import { node } from "./nodes.mjs";

const E = loadEnv(".env.testnet"); if (E.INSECURE_TLS === "1") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const n = node(E, "t1");
const GOV = E.CUSDT_GOV_PARTY ?? "cusdt-gov::12205fb8f032bfcfe6ae4ae3a7625629fe9065668ee529e3a785691e1cdce5022c2b";
const POOL = E[process.argv[2] ?? "YAP_POOL_AIRDROP"];
const P = "#yap-token:YapToken:";
const HOLD = P + "YapHolding", VEST = P + "YapVesting";
const mu = (c) => Math.round(Number(c.createArgument.amount) * 1e6);
let pass = 0, fail = 0;
const ok = (m, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}  ${m}${x ? "  — " + x : ""}`); };
const state = async () => {
  const h = (await n.acs(GOV, HOLD));
  const mine = h.filter((c) => c.createArgument.owner === POOL);
  return { supply: h.reduce((s, c) => s + mu(c), 0), free: mine.filter((c) => c.createArgument.lock == null).reduce((s, c) => s + mu(c), 0), locked: mine.filter((c) => c.createArgument.lock != null).reduce((s, c) => s + mu(c), 0) };
};
if (!POOL) throw new Error("pool party missing in .env.testnet");
const vs = (await n.acs(GOV, VEST)).filter((c) => c.createArgument.beneficiary === POOL);
if (vs.length !== 1) throw new Error(`expected 1 vesting for the pool, found ${vs.length}`);
const v = vs[0], a = v.createArgument;
const before = await state();
console.log(`pool ${POOL.split("::")[0]}: total ${a.total}, claimed ${a.claimed}, free ${before.free / 1e6}, locked ${before.locked / 1e6}, supply ${before.supply / 1e6}`);
const t0 = Date.now();
const r = await n.tx([POOL], [{ ExerciseCommand: { templateId: VEST, contractId: v.contractId, choice: "YapVesting_Claim", choiceArgument: {} } }]);
console.log(`claim confirmed in ${Date.now() - t0} ms`);
const after = await state();
const gained = after.free - before.free;
ok("something vested and was released", gained > 0, `+${gained / 1e6} YAP free`);
ok("locked part dropped by exactly the same amount", before.locked - after.locked === gained, `${(before.locked - after.locked) / 1e6}`);
ok("supply unchanged", after.supply === before.supply && after.supply === 100_000_000 * 1e6, `${after.supply / 1e6}`);
const v2 = (await n.acs(GOV, VEST)).filter((c) => c.createArgument.beneficiary === POOL);
ok("the schedule continues with the new claimed amount", v2.length === 1 && Math.round(Number(v2[0].createArgument.claimed) * 1e6) === Math.round(Number(a.claimed) * 1e6) + gained);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
