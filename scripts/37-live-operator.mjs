// LIVE test of cusdt-token 0.7.0 on the real ledger: operator/governor split (BOB plays the operator, the admin is the governor).
//   node scripts/37-live-operator.mjs        (.env.testnet = t1; about 1 minute)
// Everything created here is burnt again at the end (BurnMint), so the supply ends exactly where it started.
import { loadEnv } from "./lib.mjs";
import { T, snapshot, supply, checkInvariants } from "./invariants.mjs";
import { node, waitFor, sleep } from "./nodes.mjs";

const E = loadEnv(".env.testnet"); if (E.INSECURE_TLS === "1") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const n = node(E, "t1"), admin = E.CUSDT_ADMIN_PARTY, ALICE = E.CUSDT_ALICE, BOB = E.CUSDT_BOB, sfx = admin.split("::")[1];
const HOLD = "#cusdt-token:CusdtToken:CusdtHolding", ADM = "#cusdt-token:CusdtToken:CusdtAdmin", VEST = "#cusdt-token:CusdtToken:CusdtVesting", OPA = "#cusdt-token:CusdtToken:CusdtOperatorAuthority", PRE = "#cusdt-token:CusdtToken:CusdtTransferPreapproval", BMF = "#cusdt-token:CusdtToken:CusdtBurnMintFactory";
const I_BM = "#splice-api-token-burn-mint-v1:Splice.Api.Token.BurnMintV1:BurnMintFactory";
const inst = { admin, id: "cUSDT" }, noCtx = { context: { values: {} }, meta: { values: {} } };
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
if (!adm || !bf) throw new Error("CusdtAdmin / CusdtBurnMintFactory not found on the ledger (is 0.7.0 deployed?)");
const OP = BOB;
const auths = async () => n.acs(admin, OPA);
const allowance = async () => { const a = await auths(); return a.length === 1 ? Math.round(Number(a[0].createArgument.allowance) * 1e6) : null; };
for (const a of await auths()) await tx([admin], [ex(OPA, a.contractId, "Archive")]); // start clean

await group("appoint the operator, mint inside the allowance, allowance shrinks", async () => {
  let x = await refused(() => tx([OP], [ex(ADM, adm.contractId, "CusdtAdmin_AppointOperator", { operator: OP, allowance: amt(9000), validUntil: iso(3600000) })]));
  ok("the operator cannot appoint itself", x.refused);
  x = await refused(() => tx([admin], [ex(ADM, adm.contractId, "CusdtAdmin_AppointOperator", { operator: admin, allowance: amt(9000), validUntil: iso(3600000) })]));
  ok("operator must differ from the governor", x.refused && /differ/.test(x.msg), x.msg.slice(-90));
  await tx([admin], [ex(ADM, adm.contractId, "CusdtAdmin_AppointOperator", { operator: OP, allowance: amt(9000), validUntil: iso(3600000) })]);
  const [a] = await waitFor(async () => { const r = await auths(); return r.length ? r : null; }).then((v) => v.v ?? v);
  ok("authority exists with allowance 9000 micro", (await allowance()) === 9000);
  let r = await tx([OP], [ex(OPA, a.contractId, "CusdtOperator_Mint", { recipient: ALICE, amount: amt(5000) })]); minted += 5000;
  ok("operator minted 5000 micro for alice", !!resultOf(r, "CusdtOperator_Mint"));
  ok("allowance is now 4000", (await waitFor(async () => (await allowance()) === 4000 || null)).v === true);
  await books("operator mint", 5000);
  const [a2] = await auths();
  x = await refused(() => tx([OP], [ex(OPA, a2.contractId, "CusdtOperator_Mint", { recipient: ALICE, amount: amt(4001) })]));
  ok("over the allowance is refused", x.refused && /allowance/.test(x.msg), x.msg.slice(-90));
  x = await refused(() => tx([OP], [ex(OPA, a2.contractId, "Archive")]));
  ok("operator cannot archive its own authority", x.refused);
  x = await refused(() => tx([OP], [ex(OPA, a2.contractId, "CusdtOperatorAuthority_SetAllowance", { newAllowance: amt(99999999), newValidUntil: iso(86400000) })]));
  ok("operator cannot raise its own allowance", x.refused);
  x = await refused(() => tx([OP], [ex(ADM, adm.contractId, "CusdtAdmin_Mint", { recipient: OP, amount: amt(1) })]));
  ok("operator cannot use the governor's mint", x.refused);
  x = await refused(() => tx([ALICE], [ex(OPA, a2.contractId, "CusdtOperator_Mint", { recipient: ALICE, amount: amt(1) })]));
  ok("only the named operator can use the authority", x.refused);
  const h = (await free(ALICE)).filter((c) => !known.has(c.contractId));
  x = await refused(() => tx([OP], [ex(HOLD, h[0].contractId, "Archive")]));
  ok("operator cannot archive a holding", x.refused);
});

await group("operator: preapproval and vesting grant", async () => {
  const [a] = await auths();
  const r = await tx([OP], [ex(OPA, a.contractId, "CusdtOperator_CreatePreapproval", { receiver: OP })]);
  ok("operator created a preapproval (non-consuming)", !!resultOf(r, "CusdtOperator_CreatePreapproval"));
  const [b] = await auths();
  const g = await tx([OP], [ex(OPA, b.contractId, "CusdtOperator_GrantVesting", { beneficiary: ALICE, amount: amt(3000), start: iso(-1000), cliff: iso(-1000), finish: iso(600000), revocable: true })]); minted += 3000;
  ok("operator granted a 3000-micro vesting", !!resultOf(g, "CusdtOperator_GrantVesting"));
  ok("allowance is now 1000", (await waitFor(async () => (await allowance()) === 1000 || null)).v === true);
  const [v] = await n.acs(admin, VEST);
  const x = await refused(() => tx([OP], [ex(VEST, v.contractId, "CusdtVesting_Revoke")]));
  ok("operator cannot revoke a vesting", x.refused);
  await tx([admin], [ex(VEST, v.contractId, "CusdtVesting_Revoke")]);
  await books("operator vesting + governor revoke", 5000 + 3000);
});

await group("governor tops up, then revokes the operator", async () => {
  const [a] = await auths();
  await tx([admin], [ex(OPA, a.contractId, "CusdtOperatorAuthority_SetAllowance", { newAllowance: amt(2000), newValidUntil: iso(3600000) })]);
  ok("allowance topped up to 2000", (await waitFor(async () => (await allowance()) === 2000 || null)).v === true);
  const [b] = await auths();
  await tx([admin], [ex(OPA, b.contractId, "Archive")]);
  const x = await refused(() => tx([OP], [ex(OPA, b.contractId, "CusdtOperator_Mint", { recipient: ALICE, amount: amt(1) })]));
  ok("after revoking, the operator can do nothing", x.refused);
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
