// LIVE test of voluntary locks on the governed YAP instance (admin = cusdt-gov, 2-of-2). The OWNER locks, so no governance vote is needed;
// both participants still confirm every transaction. Owner = the airdrop pool (its FREE holding is locked and released again), lock holder
// = the marketing pool. Nothing is burnt or minted: the supply must stay exactly 100,000,000.
//   node scripts/49-live-governed-locks.mjs        (.env.testnet = t1; ~2 minutes, no human steps)
import { loadEnv } from "./lib.mjs";
import { node, sleep } from "./nodes.mjs";

const E = loadEnv(".env.testnet"); if (E.INSECURE_TLS === "1") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const n = node(E, "t1");
const GOV = E.CUSDT_GOV_PARTY ?? "cusdt-gov::12205fb8f032bfcfe6ae4ae3a7625629fe9065668ee529e3a785691e1cdce5022c2b";
const OWNER = E.YAP_POOL_AIRDROP, HOLDER = E.YAP_POOL_MARKETING;
const HOLD = "#yap-token:YapToken:YapHolding";
const mu = (c) => Math.round(Number(c.createArgument.amount) * 1e6);
const short = (e) => String(e?.message ?? e).replace(/\s+/g, " ");
let pass = 0, fail = 0;
const ok = (m, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}  ${m}${x ? "  — " + x : ""}`); };
const ex = (contractId, choice, choiceArgument = {}) => ({ ExerciseCommand: { templateId: HOLD, contractId, choice, choiceArgument } });
const refused = async (fn) => { try { await fn(); return { refused: false, msg: "ACCEPTED" }; } catch (e) { return { refused: true, msg: short(e) }; } };
const all = () => n.acs(GOV, HOLD);
const supply = async () => (await all()).reduce((s, c) => s + mu(c), 0);
const mine = async () => (await all()).filter((c) => c.createArgument.owner === OWNER);
const created = (r) => (r?.transaction?.events ?? []).map((e) => e.CreatedEvent).filter((e) => e && e.templateId.includes("YapHolding")).map((e) => e.contractId);
const vol = (c) => String(c.createArgument.lock?.context ?? "").startsWith("cusdt/voluntary-lock");
const iso = (ms) => new Date(Date.now() + ms).toISOString();

// a leftover voluntary test lock from an interrupted run is released first (by its holder)
for (const c of (await mine()).filter(vol)) await n.tx([HOLDER], [ex(c.contractId, "YapHolding_UnlockEarly")]);
const s0 = await supply();
const free = (await mine()).filter((c) => c.createArgument.lock == null).sort((a, b) => mu(a) - mu(b));
if (!free.length) throw new Error("the owner has no free holding");
const h0 = free[0];
console.log(`start: supply ${s0 / 1e6}; locking the owner's free holding of ${mu(h0) / 1e6} YAP`);

console.log("-- lock with an early-release holder");
let r = await n.tx([OWNER], [ex(h0.contractId, "YapHolding_Lock", { holders: [HOLDER], expiresAt: iso(10 * 60_000), context: "governed lock test" })]);
let locked = (await mine()).find(vol);
ok("the holding is now locked, same amount", !!locked && mu(locked) === mu(h0));
ok("locking again is refused", (await refused(() => n.tx([OWNER], [ex(locked.contractId, "YapHolding_Lock", { holders: [HOLDER], expiresAt: iso(60_000), context: "again" })]))).refused);
const burn = await refused(() => n.tx([OWNER], [ex(locked.contractId, "YapHolding_Burn")]));
ok("a locked holding cannot be burnt", burn.refused, burn.msg.slice(0, 90));
ok("the owner cannot release the lock early", (await refused(() => n.tx([OWNER], [ex(locked.contractId, "YapHolding_UnlockEarly")]))).refused);
ok("the lock is not expired yet: UnlockExpired is refused", (await refused(() => n.tx([OWNER], [ex(locked.contractId, "YapHolding_UnlockExpired")]))).refused);
ok("supply unchanged while locked", (await supply()) === s0);

console.log("-- the holder releases early");
await n.tx([HOLDER], [ex(locked.contractId, "YapHolding_UnlockEarly")]);
const afterEarly = await mine();
ok("the holding is free again, same amount", afterEarly.some((c) => c.createArgument.lock == null && mu(c) === mu(h0)) && !afterEarly.some(vol));

console.log("-- pure time lock (no holders), 40 s");
const free2 = (await mine()).find((c) => c.createArgument.lock == null && mu(c) === mu(h0));
await n.tx([OWNER], [ex(free2.contractId, "YapHolding_Lock", { holders: [], expiresAt: iso(40_000), context: "pure time lock" })]);
locked = (await mine()).find(vol);
ok("pure time lock created", !!locked);
ok("nobody can shorten it: UnlockEarly is refused", (await refused(() => n.tx([OWNER, HOLDER], [ex(locked.contractId, "YapHolding_UnlockEarly")]))).refused);
await sleep(45_000);
await n.tx([OWNER], [ex(locked.contractId, "YapHolding_UnlockExpired")]);
const fin = await mine();
ok("after expiry the owner tidies up: free holding, same amount, no lock left", fin.some((c) => c.createArgument.lock == null && mu(c) === mu(h0)) && !fin.some(vol));
ok("supply unchanged at the end", (await supply()) === s0 && s0 === 100_000_000 * 1e6, `${(await supply()) / 1e6}`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
