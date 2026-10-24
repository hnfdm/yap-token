// LIVE test of yap-token 0.6.0 on the real ledger: voluntary locks, lock expiry, linear vesting (claim / revoke / close).
//   node scripts/36-live-lock-vesting.mjs        (.env.testnet = t1; takes about 4 minutes: it waits for real time to pass)
// Everything created here is burnt again at the end (BurnMint), so the supply ends exactly where it started.
import { loadEnv } from "./lib.mjs";
import { T, snapshot, supply, checkInvariants } from "./invariants.mjs";
import { node, waitFor, sleep } from "./nodes.mjs";

const E = loadEnv(".env.testnet"); if (E.INSECURE_TLS === "1") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const n = node(E, "t1"), admin = E.CUSDT_ADMIN_PARTY, ALICE = E.CUSDT_ALICE, BOB = E.CUSDT_BOB, sfx = admin.split("::")[1];
const HOLD = "#yap-token:YapToken:YapHolding", ADM = "#yap-token:YapToken:YapAdmin", VEST = "#yap-token:YapToken:YapVesting", BMF = "#yap-token:YapToken:YapBurnMintFactory";
const I_BM = "#splice-api-token-burn-mint-v1:Splice.Api.Token.BurnMintV1:BurnMintFactory";
const inst = { admin, id: "YAP" }, noCtx = { context: { values: {} }, meta: { values: {} } };
const short = (e) => String(e?.message ?? e).replace(/\s+/g, " ");
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const mu = (c) => Math.round(Number(c.createArgument.amount) * 1e6);
const amt = (m) => (m / 1e6).toFixed(10);
let pass = 0, fail = 0, txs = 0;
const ok = (m, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}  ${m}${x ? "  — " + x : ""}`); };
const tx = async (actAs, commands) => { txs++; return n.tx(actAs, commands); };
const refused = async (fn, re) => { try { await fn(); return { refused: false, msg: "ACCEPTED" }; } catch (e) { const m = short(e); return { refused: true, matched: re ? re.test(m) : true, msg: m }; } };
const all = async (p) => (await n.acs(p, HOLD)).filter((c) => c.createArgument.owner === p);
const free = async (p) => (await all(p)).filter((c) => c.createArgument.lock == null);
const lockedOf = async (p) => (await all(p)).filter((c) => c.createArgument.lock != null);
const sum = (hs) => hs.reduce((s, c) => s + mu(c), 0);
const ex = (templateId, contractId, choice, choiceArgument = {}) => ({ ExerciseCommand: { templateId, contractId, choice, choiceArgument } });
const resultOf = (r, choice) => r.transaction.events.find((e) => e.ExercisedEvent?.choice === choice)?.ExercisedEvent?.exerciseResult;
const sleepUntil = async (ms, label) => { const s = Math.max(0, ms - Date.now()); if (s > 0) { console.log(`      ... waiting ${(s / 1000).toFixed(0)} s (${label})`); await sleep(s); } };

// ---- guard: traffic headroom ----
try {
  const j = await (await fetch(`https://lighthouse.testnet.cantonloop.com/api/validators/${encodeURIComponent("cryptolampung-testnet-1::" + sfx)}`, { headers: E.LIGHTHOUSE_API_KEY ? { Authorization: "Bearer " + E.LIGHTHOUSE_API_KEY } : {}, signal: AbortSignal.timeout(20000) })).json();
  const t = j.traffic_status; if (t) { const head = t.total_limit - t.total_consumed; console.log(`t1 traffic headroom: ${head}`); if (head < 100_000) { console.log("too little headroom, refusing"); process.exit(3); } }
} catch { console.log("(traffic headroom unknown, continuing)"); }

const S0 = await snapshot(await n.token(), admin), expected = supply(S0);
const known = new Set([...(await all(ALICE)), ...(await all(BOB)), ...(await all(admin))].map((c) => c.contractId));
console.log(`start: supply ${expected / 1e6}`);
const books = async (label, extra = 0) => { const v = checkInvariants(await snapshot(await n.token(), admin), expected + extra); ok(`conservation after ${label}`, v.length === 0, v.join("; ")); };
const bm = async (bf, inputs, owners) => tx([admin, ...owners], [ex(I_BM, bf.contractId, "BurnMintFactory_BurnMint", { expectedAdmin: admin, instrumentId: inst, inputHoldingCids: inputs, outputs: [], extraActors: owners, extraArgs: noCtx })]);
async function group(name, fn) { console.log(`-- ${name}`); try { await fn(); } catch (e) { fail++; console.log(`FAIL  ${name} threw: ${short(e).slice(0, 400)}`); } }

const [adm] = await n.acs(admin, ADM), [bf] = await n.acs(admin, BMF);
if (!adm || !bf) throw new Error("YapAdmin / YapBurnMintFactory not found on the ledger");
let minted = 0;

await group("voluntary lock: guards, early release by the holder, pure time lock that expires", async () => {
  await tx([admin], [ex(ADM, adm.contractId, "YapAdmin_Mint", { recipient: ALICE, amount: amt(4000) })]); minted += 4000;
  const h = (await waitFor(async () => (await free(ALICE)).find((c) => !known.has(c.contractId) && mu(c) === 4000))).v;
  ok("minted a 4000-micro holding for alice", !!h);
  let x = await refused(() => tx([BOB], [ex(HOLD, h.contractId, "YapHolding_Lock", { holders: [BOB], expiresAt: iso(60000), context: "x" })]));
  ok("only the owner can lock", x.refused);
  x = await refused(() => tx([ALICE], [ex(HOLD, h.contractId, "YapHolding_Lock", { holders: [ALICE], expiresAt: iso(60000), context: "x" })]));
  ok("the owner cannot be a lock holder", x.refused && /holder/.test(x.msg), x.msg.slice(-90));
  x = await refused(() => tx([ALICE], [ex(HOLD, h.contractId, "YapHolding_Lock", { holders: [BOB], expiresAt: iso(-5000), context: "x" })]));
  ok("expiresAt must be in the future", x.refused && /future/.test(x.msg), x.msg.slice(-90));
  const r = await tx([ALICE], [ex(HOLD, h.contractId, "YapHolding_Lock", { holders: [BOB], expiresAt: iso(120000), context: "live test" })]);
  const lcid = resultOf(r, "YapHolding_Lock");
  ok("alice locked her holding for 2 minutes with bob as the holder", !!lcid);
  x = await refused(() => tx([ALICE], [ex(HOLD, lcid, "YapHolding_Split", { splitAmount: amt(1000) })]));
  ok("a locked holding cannot be split", x.refused && /locked/.test(x.msg), x.msg.slice(-90));
  x = await refused(() => tx([ALICE], [ex(HOLD, lcid, "YapHolding_UnlockEarly")]));
  ok("the owner cannot release her own lock early", x.refused);
  x = await refused(() => tx([admin], [ex(HOLD, lcid, "YapHolding_UnlockEarly")]));
  ok("the issuer cannot release it early either", x.refused);
  const r2 = await tx([BOB], [ex(HOLD, lcid, "YapHolding_UnlockEarly")]);
  const ucid = resultOf(r2, "YapHolding_UnlockEarly");
  ok("the holder (bob) releases it early", !!ucid && (await lockedOf(ALICE)).filter((c) => !known.has(c.contractId)).length === 0);
  // pure time lock: nobody can shorten it; it expires by itself and the holding is then spendable
  const r3 = await tx([ALICE], [ex(HOLD, ucid, "YapHolding_Lock", { holders: [], expiresAt: iso(35000), context: "time lock" })]);
  const tcid = resultOf(r3, "YapHolding_Lock"); const lockedAt = Date.now();
  x = await refused(() => tx([BOB], [ex(HOLD, tcid, "YapHolding_UnlockEarly")]));
  ok("nobody can shorten a pure time lock", x.refused);
  x = await refused(() => tx([ALICE], [ex(HOLD, tcid, "YapHolding_Split", { splitAmount: amt(1000) })]));
  ok("still locked before the expiry", x.refused);
  await sleepUntil(lockedAt + 42000, "the time lock expires");
  const r4 = await tx([ALICE], [ex(HOLD, tcid, "YapHolding_Split", { splitAmount: amt(1000) })]);
  ok("after the expiry the owner can use the holding without any unlock step", !!resultOf(r4, "YapHolding_Split"));
  await books("locks", 4000);
});

await group("linear vesting: grant, cliff, partial claim, revoke", async () => {
  const total = 90000;   // micro: over 90 s that is 1000 micro per second
  const t0 = Date.now();
  const gr = await tx([admin], [ex(ADM, adm.contractId, "YapAdmin_GrantVesting", { beneficiary: BOB, amount: amt(total), start: iso(0), cliff: iso(30000), finish: iso(90000), revocable: true })]);
  const vcid = resultOf(gr, "YapAdmin_GrantVesting"); minted += total;
  ok("admin granted 90000 micro to bob, vesting over 90 s with a 30 s cliff", !!vcid);
  const lk = (await lockedOf(BOB)).filter((c) => !known.has(c.contractId));
  ok("the grant sits in one locked holding of bob (lock holder = admin)", lk.length === 1 && mu(lk[0]) === total && JSON.stringify(lk[0].createArgument.lock.holders) === JSON.stringify([admin]));
  let x = await refused(() => tx([ALICE], [ex(VEST, vcid, "YapVesting_Claim")]));
  ok("only the beneficiary can claim", x.refused);
  x = await refused(() => tx([BOB], [ex(VEST, vcid, "YapVesting_Claim")]));
  ok("before the cliff nothing can be claimed", x.refused && /nothing has vested/.test(x.msg), x.msg.slice(-80));
  x = await refused(() => tx([BOB], [ex(VEST, vcid, "YapVesting_Revoke")]));
  ok("only the admin can revoke", x.refused);
  await sleepUntil(t0 + 48000, "past the cliff, about half vested");
  const c1 = await tx([BOB], [ex(VEST, vcid, "YapVesting_Claim")]);
  const res1 = resultOf(c1, "YapVesting_Claim");
  const v1 = res1?._2 ?? res1?.[1]; const rel1 = (await free(BOB)).filter((c) => !known.has(c.contractId)).reduce((s, c) => s + mu(c), 0);
  ok("claim after the cliff released a plausible share (about 45 s of 90)", rel1 > 25000 && rel1 < 75000, `${rel1} micro of ${total}`);
  ok("a new schedule remains for the rest", !!v1);
  const locked1 = (await lockedOf(BOB)).filter((c) => !known.has(c.contractId));
  ok("the remainder is still locked, exactly total - claimed", locked1.length === 1 && mu(locked1[0]) === total - rel1, `${locked1.map(mu)} left`);
  await sleepUntil(t0 + 62000, "a bit later, then the admin revokes");
  const rv = await tx([admin], [ex(VEST, v1, "YapVesting_Revoke")]);
  const bobFree = (await free(BOB)).filter((c) => !known.has(c.contractId)).reduce((s, c) => s + mu(c), 0);
  const adminFree = (await free(admin)).filter((c) => !known.has(c.contractId)).reduce((s, c) => s + mu(c), 0);
  ok("revoke: the vested part is bob's, the unvested part is back with the admin", bobFree > rel1 && adminFree > 0, `bob ${bobFree}, admin ${adminFree}`);
  ok("nothing is lost: bob + admin = the whole grant", bobFree + adminFree === total, `${bobFree + adminFree} / ${total}`);
  ok("nothing stays locked", (await lockedOf(BOB)).filter((c) => !known.has(c.contractId)).length === 0);
  ok("the schedule is gone", (await n.acs(admin, VEST)).filter((c) => c.createArgument.beneficiary === BOB).length === 0);
  await books("vesting revoke", 4000 + total);
});

await group("linear vesting: a grant that is NOT revocable, claimed after the end", async () => {
  const total = 30000;
  const t0 = Date.now();
  const gr = await tx([admin], [ex(ADM, adm.contractId, "YapAdmin_GrantVesting", { beneficiary: ALICE, amount: amt(total), start: iso(0), cliff: iso(0), finish: iso(30000), revocable: false })]);
  const vcid = resultOf(gr, "YapAdmin_GrantVesting"); minted += total;
  let x = await refused(() => tx([admin], [ex(VEST, vcid, "YapVesting_Revoke")]));
  ok("a non-revocable grant cannot be revoked", x.refused && /not revocable/.test(x.msg), x.msg.slice(-80));
  x = await refused(() => tx([ALICE], [ex(VEST, vcid, "YapVesting_Close")]));
  ok("the schedule cannot be closed before its end", x.refused);
  await sleepUntil(t0 + 36000, "the schedule ends");
  const c = await tx([ALICE], [ex(VEST, vcid, "YapVesting_Claim")]);
  const res = resultOf(c, "YapVesting_Claim");
  const got = (await free(ALICE)).filter((h) => !known.has(h.contractId) && mu(h) === total);
  ok("after the end the beneficiary claims everything at once", got.length === 1 && (res?._2 ?? res?.[1]) == null, `${got.map(mu)}`);
  await books("vesting end", 4000 + 90000 + total);
});

// ---- burn everything this test created, so the supply is back where it started ----
await group("clean up: burn what the test created", async () => {
  for (const p of [ALICE, BOB, admin]) {
    const mine = (await free(p)).filter((c) => !known.has(c.contractId));
    if (!mine.length) continue;
    await bm(bf, mine.map((c) => c.contractId), [p]);
  }
  const left = [...(await all(ALICE)), ...(await all(BOB)), ...(await all(admin))].filter((c) => !known.has(c.contractId));
  ok("no holding created by this test is left", left.length === 0, left.map(mu).join(","));
  const sup = supply(await snapshot(await n.token(), admin));
  ok("supply is back to the start", sup === expected, `${sup - expected} micro off (minted ${minted})`);
});

console.log(`\ntransactions submitted by this test: ${txs}\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
