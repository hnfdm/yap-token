// LIVE test of the governed BurnTreasury (yap-governance 0.2.0) on the decentralized-admin instance (admin = cusdt-gov, 2-of-2 over t1 + t2).
//   node scripts/41-live-governed-burn.mjs        (.env.testnet = t1; two HUMAN steps: confirm on both nodes + execute on t1, twice)
// Flow: the operator is appointed (governed), creates a PREAPPROVAL for the governor and mints 4000 micro for alice; alice and bob then send
// every holding they have to the governor (direct transfers through the registry); finally ONE governed BurnTreasury proposal burns the lot.
// Goal: supply of the governed instance back to 0 (it ends with whatever it had before this test minus nothing: net zero for what this test minted).
import { spawn } from "node:child_process";
import { loadEnv } from "./lib.mjs";
import { node, waitFor, sleep } from "./nodes.mjs";

const E = loadEnv(".env.testnet"); if (E.INSECURE_TLS === "1") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const n = node(E, "t1");
const GOV = E.CUSDT_GOV_PARTY ?? "cusdt-gov::12205fb8f032bfcfe6ae4ae3a7625629fe9065668ee529e3a785691e1cdce5022c2b";
const MEMBER = E.CUSDT_GOV_MEMBER ?? "cryptolampung-testnet-1::122013397e0d9bb71891e884ccd6948a93057115a2fd46a5cf2e4db254844bbd0ea1";
const ALICE = E.CUSDT_ALICE, BOB = E.CUSDT_BOB, OP = E.CUSDT_OPERATOR;
const P = "#yap-token:YapToken:", G = "#yap-governance:YapGovernance:";
const HOLD = P + "YapHolding", ADM = P + "YapAdmin", OPA = P + "YapOperatorAuthority", PRE = P + "YapTransferPreapproval", BMF = P + "YapBurnMintFactory";
const I_TF2 = "#splice-api-token-transfer-instruction-v2:Splice.Api.Token.TransferInstructionV2:TransferFactory";
const inst = { admin: GOV, id: "YAP" };
const short = (e) => String(e?.message ?? e).replace(/\s+/g, " ");
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const mu = (c) => Math.round(Number(c.createArgument.amount) * 1e6);
const amt = (m) => (m / 1e6).toFixed(10);
const acct = (p) => ({ owner: p, provider: null, id: "" });
let pass = 0, fail = 0;
const ok = (m, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}  ${m}${x ? "  — " + x : ""}`); };
const ex = (templateId, contractId, choice, choiceArgument = {}) => ({ ExerciseCommand: { templateId, contractId, choice, choiceArgument } });
const refused = async (fn) => { try { await fn(); return { refused: false, msg: "ACCEPTED" }; } catch (e) { return { refused: true, msg: short(e) }; } };
const holdings = async (p) => (await n.acs(GOV, HOLD)).filter((c) => c.createArgument.owner === p && c.createArgument.lock == null);
const total = async (p) => (await holdings(p)).reduce((s, c) => s + mu(c), 0);
const supplyNow = async () => (await n.acs(GOV, HOLD)).reduce((s, c) => s + mu(c), 0);
const auth = async () => (await n.acs(GOV, OPA)).filter((a) => a.createArgument.operator === OP);
const HUMAN = 20 * 60_000;
const human = (what, label) => console.log(`\n   >>> HUMAN STEP: ${what}\n       t1:  bash decman-vote-on-vps.sh confirm ${label}\n       t2:  bash decman-vote-on-vps.sh confirm ${label}\n       t1:  bash decman-vote-on-vps.sh execute ${label}\n   (waiting up to 20 minutes ...)\n`);
async function group(name, fn) { console.log(`-- ${name}`); try { await fn(); } catch (e) { fail++; console.log(`FAIL  ${name} threw: ${short(e).slice(0, 500)}`); } }

const [adm] = await n.acs(GOV, ADM), [bmf] = await n.acs(GOV, BMF);
if (!adm || !bmf) throw new Error("YapAdmin / YapBurnMintFactory of cusdt-gov not found (finish the decman-cusdt contracts step first)");
const supply0 = await supplyNow();
console.log(`start: governed supply ${supply0 / 1e6}; alice ${await total(ALICE)} bob ${await total(BOB)} gov ${await total(GOV)} micro`);
let minted = 0;

const reg = spawn(process.execPath, ["registry/src/server.mjs"], { env: { ...process.env, HOST: "127.0.0.1", PORT: "18791", LEDGER_URL: E.LEDGER_URL, KC_TOKEN_URL: E.KC_TOKEN_URL, KC_CLIENT_ID: E.KC_CLIENT_ID, KC_CLIENT_SECRET: E.KC_CLIENT_SECRET, KC_SCOPE: E.KC_SCOPE ?? "daml_ledger_api", CUSDT_ADMIN_PARTY: GOV, CUSDT_ENABLE_V2: "1", NODE_TLS_REJECT_UNAUTHORIZED: "0" }, stdio: ["ignore", "ignore", "inherit"] });
await sleep(1500);
const rpost = (path, body) => fetch(`http://127.0.0.1:18791${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, j: await r.json().catch(() => null) }));
// alice / bob send ONE holding to the governor through the registry (V2)
const sendToGov = async (from, holding) => {
  const t = { sender: acct(from), receiver: acct(GOV), amount: amt(mu(holding)), instrumentId: inst, requestedAt: iso(-30000), executeBefore: iso(3_600_000), inputHoldingCids: [holding.contractId], meta: { values: {} } };
  const f = await rpost("/registry/transfer-instruction/v2/transfer-factory", { choiceArguments: { transfer: t } });
  if (f.j?.transferKind !== "direct") throw new Error(`expected a DIRECT transfer to the governor, registry said ${f.status} ${f.j?.transferKind}`);
  await n.tx([from], [ex(I_TF2, f.j.factoryId, "TransferFactory_Transfer", { transfer: t, actors: [from], extraArgs: { context: f.j.choiceContext.choiceContextData, meta: { values: {} } } })], f.j.choiceContext.disclosedContracts);
};

try {
  await group("governed: appoint the operator (30 minutes, 6000 micro)", async () => {
    if ((await auth()).length === 0) {
      await n.tx([MEMBER], [{ CreateCommand: { templateId: G + "AppointOperatorProposal", createArguments: { governanceParty: GOV, proposer: MEMBER, adminCid: adm.contractId, operator: OP, allowance: amt(6000), validUntil: iso(30 * 60_000 + HUMAN) } } }]);
      human("appoint the operator", "YapAppointOperator");
      const w = await waitFor(async () => (await auth())[0] ?? null, HUMAN);
      ok("the operator authority appeared", !!w.v, `${w.s}s`);
    } else console.log("(an authority already exists, using it)");
  });

  await group("the operator makes a preapproval for the governor and mints 4000 micro for alice", async () => {
    const [a] = await auth();
    const hasPre = (await n.acs(GOV, PRE)).some((p) => p.createArgument.receiver === GOV);
    if (!hasPre) await n.tx([OP], [ex(OPA, a.contractId, "YapOperator_CreatePreapproval", { receiver: GOV })]);
    ok("the governor has a transfer preapproval", (await waitFor(async () => ((await n.acs(GOV, PRE)).some((p) => p.createArgument.receiver === GOV) ? true : null))).v === true);
    const [a2] = await auth();
    const before = new Set((await holdings(ALICE)).map((c) => c.contractId));
    await n.tx([OP], [ex(OPA, a2.contractId, "YapOperator_Mint", { recipient: ALICE, amount: amt(4000) })]); minted += 4000;
    ok("alice got the 4000-micro holding", !!(await waitFor(async () => (await holdings(ALICE)).find((c) => !before.has(c.contractId) && mu(c) === 4000))).v);
  });

  await group("a holder cannot be burnt by governance directly: holdings go to the governor first (direct transfers)", async () => {
    for (const p of [ALICE, BOB]) for (const h of await holdings(p)) await sendToGov(p, h);
    await sleep(2500);
    ok("alice and bob hold nothing any more", (await total(ALICE)) === 0 && (await total(BOB)) === 0);
    const g = await total(GOV);
    ok("the governor holds the whole supply", g === (await supplyNow()), `${g} micro`);
  });

  await group("governed: BurnTreasury burns every governor holding (propose -> t1 + t2 confirm -> execute)", async () => {
    const hs = await holdings(GOV);
    await n.tx([MEMBER], [{ CreateCommand: { templateId: G + "BurnTreasuryProposal", createArguments: { governanceParty: GOV, proposer: MEMBER, factoryCid: bmf.contractId, holdingCids: hs.map((h) => h.contractId) } } }]);
    ok("t1's validator party created the BurnTreasuryProposal", true, `${hs.length} holding(s), ${hs.reduce((s, c) => s + mu(c), 0)} micro`);
    human("burn the governor's holdings", "YapBurnTreasury");
    const w = await waitFor(async () => ((await total(GOV)) === 0 ? true : null), HUMAN);
    ok("the governor's holdings are gone after the governed burn", !!w.v, `${w.s}s`);
    ok("governed supply is 0", (await supplyNow()) === 0, `${await supplyNow()} micro`);
  });
} finally { reg.kill(); }
console.log(`\n${pass} passed, ${fail} failed  (this test minted ${minted} micro; started from ${supply0})`);
process.exitCode = fail ? 1 : 0;
