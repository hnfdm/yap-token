// LIVE contention test of yap-token 0.7.0: YapOperator_Mint is CONSUMING (it recreates the authority with a smaller allowance),
// so parallel mints from the same authority collide. This measures how bad it is and whether "re-read the latest authority + retry" is enough.
//   node scripts/39-live-operator-contention.mjs      (.env.testnet = t1, needs CUSDT_OPERATOR)
import { loadEnv } from "./lib.mjs";
import { snapshot, supply } from "./invariants.mjs";
import { node, waitFor, sleep } from "./nodes.mjs";

const E = loadEnv(".env.testnet"); if (E.INSECURE_TLS === "1") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const n = node(E, "t1"), admin = E.CUSDT_ADMIN_PARTY, ALICE = E.CUSDT_ALICE, OP = E.CUSDT_OPERATOR;
const P = "#yap-token:YapToken:", HOLD = P + "YapHolding", ADM = P + "YapAdmin", OPA = P + "YapOperatorAuthority", BMF = P + "YapBurnMintFactory";
const I_BM = "#splice-api-token-burn-mint-v1:Splice.Api.Token.BurnMintV1:BurnMintFactory";
const inst = { admin, id: "YAP" }, noCtx = { context: { values: {} }, meta: { values: {} } };
const amt = (m) => (m / 1e6).toFixed(10), mu = (c) => Math.round(Number(c.createArgument.amount) * 1e6);
const ex = (templateId, contractId, choice, choiceArgument = {}) => ({ ExerciseCommand: { templateId, contractId, choice, choiceArgument } });
const iso = (ms) => new Date(Date.now() + ms).toISOString();
let pass = 0, fail = 0;
const ok = (m, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}  ${m}${x ? "  — " + x : ""}`); };
const N = 8, EACH = 1000;
const S0 = supply(await snapshot(await n.token(), admin));
const [adm] = await n.acs(admin, ADM), [bf] = await n.acs(admin, BMF);
const mine = async () => (await n.acs(ALICE, HOLD)).filter((c) => c.createArgument.owner === ALICE && c.createArgument.lock == null && mu(c) === EACH);
const base = (await mine()).length;
const auth = async () => (await n.acs(admin, OPA))[0];
for (const a of await n.acs(admin, OPA)) await n.tx([admin], [ex(OPA, a.contractId, "Archive")]);
await n.tx([admin], [ex(ADM, adm.contractId, "YapAdmin_AppointOperator", { operator: OP, allowance: amt(1_000_000), validUntil: iso(3_600_000) })]);
await waitFor(async () => (await auth()) || null);

// A: all N at once from the SAME authority contract id (what a naive client does)
const a0 = await auth();
const t0 = Date.now();
const rA = await Promise.allSettled(Array.from({ length: N }, () => n.tx([OP], [ex(OPA, a0.contractId, "YapOperator_Mint", { recipient: ALICE, amount: amt(EACH) })])));
const okA = rA.filter((r) => r.status === "fulfilled").length;
console.log(`A) ${N} parallel mints on the same authority cid: ${okA} succeeded, ${N - okA} failed in ${Date.now() - t0} ms`);
console.log("   failure reasons:", [...new Set(rA.filter((r) => r.status === "rejected").map((r) => String(r.reason.message).match(/CONTRACT_NOT_FOUND|LOCAL_VERDICT[A-Z_]*|INACTIVE[A-Z_]*|ABORTED|CONTRACT_NOT_ACTIVE|[A-Z_]{8,}/)?.[0] ?? "other"))].join(", "));
ok("exactly one of the parallel mints wins (the authority is consumed once)", okA === 1, `${okA}`);

// B: N workers, each re-reads the latest authority and retries until its mint lands
let retries = 0;
const t1 = Date.now();
const worker = async () => { for (let k = 0; k < 40; k++) { try { const a = await auth(); if (!a) { await sleep(300); continue; } await n.tx([OP], [ex(OPA, a.contractId, "YapOperator_Mint", { recipient: ALICE, amount: amt(EACH) })]); return true; } catch { retries++; await sleep(150 + Math.random() * 400); } } return false; };
const rB = await Promise.all(Array.from({ length: N }, worker));
const okB = rB.filter(Boolean).length;
console.log(`B) ${N} parallel workers with re-read + retry: ${okB} landed, ${retries} retries, ${Date.now() - t1} ms`);
ok("with re-read + retry every mint lands", okB === N);
const a1 = await waitFor(async () => { const a = await auth(); return a && Math.round(Number(a.createArgument.allowance) * 1e6) === 1_000_000 - (okA + okB) * EACH ? a : null; });
ok("allowance went down by exactly (landed mints) x 1000 micro", !!a1.v, `${okA + okB} mints`);

// clean up
const minted = (await waitFor(async () => { const m = await mine(); return m.length - base >= okA + okB ? m : null; })).v ?? await mine();
const fresh = minted.filter(Boolean);
await n.tx([admin, ALICE], [ex(I_BM, bf.contractId, "BurnMintFactory_BurnMint", { expectedAdmin: admin, instrumentId: inst, inputHoldingCids: fresh.map((c) => c.contractId), outputs: [], extraActors: [ALICE], extraArgs: noCtx })]);
for (const a of await n.acs(admin, OPA)) await n.tx([admin], [ex(OPA, a.contractId, "Archive")]);
const S1 = supply(await snapshot(await n.token(), admin));
ok("supply is back to the start", S1 === S0, `${S1 - S0} micro off`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
