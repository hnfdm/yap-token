// LIVE test of YAP with a DECENTRALIZED admin: the governor is the 2-of-2 party cusdt-gov (DecMan, nodes t1 + t2), the operator is cusdt-operator.
//   node scripts/40-live-governed.mjs        (.env.testnet = t1; has two HUMAN steps: confirming/executing the proposals on the two VPSes)
// This is a SEPARATE YAP instance (its own admin = cusdt-gov); the single-admin instance used by tests 35-39 is not touched.
// It leaves a few micro-units of supply in the governed instance (BurnMint needs a governance wrapper that does not exist yet).
import { spawn } from "node:child_process";
import { loadEnv } from "./lib.mjs";
import { node, waitFor, sleep } from "./nodes.mjs";

const E = loadEnv(".env.testnet"); if (E.INSECURE_TLS === "1") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const n = node(E, "t1");
const GOV = E.CUSDT_GOV_PARTY ?? "cusdt-gov::12205fb8f032bfcfe6ae4ae3a7625629fe9065668ee529e3a785691e1cdce5022c2b";
const MEMBER = E.CUSDT_GOV_MEMBER ?? "cryptolampung-testnet-1::122013397e0d9bb71891e884ccd6948a93057115a2fd46a5cf2e4db254844bbd0ea1"; // t1's validator party = the proposer
const ALICE = E.CUSDT_ALICE, BOB = E.CUSDT_BOB, OP = E.CUSDT_OPERATOR;
const P = "#yap-token:YapToken:", G = "#yap-governance:YapGovernance:";
const HOLD = P + "YapHolding", ADM = P + "YapAdmin", OPA = P + "YapOperatorAuthority", INSTR = P + "YapTransferInstruction";
const I_TF2 = "#splice-api-token-transfer-instruction-v2:Splice.Api.Token.TransferInstructionV2:TransferFactory";
const I_TI2 = "#splice-api-token-transfer-instruction-v2:Splice.Api.Token.TransferInstructionV2:TransferInstruction";
const inst = { admin: GOV, id: "YAP" }, noCtx = { context: { values: {} }, meta: { values: {} } };
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
const auth = async () => (await n.acs(GOV, OPA)).filter((a) => a.createArgument.operator === OP);
const HUMAN = 20 * 60_000;
const human = (what, lines) => console.log(`\n   >>> HUMAN STEP: ${what}\n${lines.map((l) => "       " + l).join("\n")}\n   (waiting up to 20 minutes ...)\n`);
async function group(name, fn) { console.log(`-- ${name}`); try { await fn(); } catch (e) { fail++; console.log(`FAIL  ${name} threw: ${short(e).slice(0, 500)}`); } }
const voteLines = (label) => [`t1:  bash decman-vote-on-vps.sh confirm ${label}`, `t2:  bash decman-vote-on-vps.sh confirm ${label}`, `t1:  bash decman-vote-on-vps.sh execute ${label}`];

const [adm] = await n.acs(GOV, ADM);
const tf = (await n.acs(GOV, P + "YapTransferFactory"))[0];
if (!adm || !tf) throw new Error("YapAdmin / YapTransferFactory of cusdt-gov not found: finish decman-cusdt-on-vps.sh contracts + accept-contracts first");
console.log("governed instance found: YapAdmin + TransferFactory are signed by", GOV.split("::")[0]);
const supplyNow = async () => (await n.acs(GOV, HOLD)).reduce((s, c) => s + mu(c), 0);
const supply0 = await supplyNow();
console.log(`start: supply ${supply0 / 1e6}`);
for (const a of await auth()) console.log("(note: an operator authority for cusdt-operator already exists on this governed instance; the test continues with it)");

await group("one node alone is powerless: a direct command as the governor is refused", async () => {
  const x = await refused(() => n.tx([GOV], [ex(ADM, adm.contractId, "YapAdmin_AppointOperator", { operator: OP, allowance: amt(1_000_000), validUntil: iso(3_600_000) })]));
  ok("t1 cannot act as cusdt-gov by itself (no submission permission)", x.refused, x.msg.slice(0, 160));
});

let authorityCid = null;
await group("governed: appoint the operator (propose -> t1 confirm -> t2 confirm -> execute)", async () => {
  if ((await auth()).length === 0) {
    await n.tx([MEMBER], [{ CreateCommand: { templateId: G + "AppointOperatorProposal", createArguments: { governanceParty: GOV, proposer: MEMBER, adminCid: adm.contractId, operator: OP, allowance: amt(20000), validUntil: iso(7_200_000) } } }]);
    ok("t1's validator party created the AppointOperatorProposal", true);
    human("confirm on both nodes, then execute on t1 (run in /root where decman-vote-on-vps.sh is)", voteLines("YapAppointOperator"));
    const w = await waitFor(async () => (await auth())[0] ?? null, HUMAN);
    ok("the operator authority appeared after the governed execution", !!w.v, `${w.s}s`);
  }
  const [a] = await auth(); authorityCid = a?.contractId;
  ok("authority is signed by the decentralized admin with allowance 20000 micro", a && a.createArgument.admin === GOV && mu({ createArgument: { amount: a.createArgument.allowance } }) === 20000);
});

await group("the operator mints inside its allowance; transfers work through the registry (V2 offer + accept)", async () => {
  const reg = spawn(process.execPath, ["registry/src/server.mjs"], { env: { ...process.env, HOST: "127.0.0.1", PORT: "18790", LEDGER_URL: E.LEDGER_URL, KC_TOKEN_URL: E.KC_TOKEN_URL, KC_CLIENT_ID: E.KC_CLIENT_ID, KC_CLIENT_SECRET: E.KC_CLIENT_SECRET, KC_SCOPE: E.KC_SCOPE ?? "daml_ledger_api", CUSDT_ADMIN_PARTY: GOV, CUSDT_ENABLE_V2: "1", NODE_TLS_REJECT_UNAUTHORIZED: "0" }, stdio: ["ignore", "ignore", "inherit"] });
  try {
    await sleep(1500);
    const [a] = await auth();
    const before = new Set((await holdings(ALICE)).map((c) => c.contractId));
    await n.tx([OP], [ex(OPA, a.contractId, "YapOperator_Mint", { recipient: ALICE, amount: amt(5000) })]);
    const h = (await waitFor(async () => (await holdings(ALICE)).find((c) => !before.has(c.contractId) && mu(c) === 5000))).v;
    ok("operator minted 5000 micro for alice on the governed instance", !!h);
    const [a2] = await auth();
    ok("allowance is now 15000", mu({ createArgument: { amount: a2.createArgument.allowance } }) === 15000);
    let x = await refused(() => n.tx([OP], [ex(OPA, a2.contractId, "YapOperator_Mint", { recipient: ALICE, amount: amt(15001) })]));
    ok("over the allowance is refused", x.refused);
    x = await refused(() => n.tx([OP], [ex(OPA, a2.contractId, "YapOperatorAuthority_SetAllowance", { newAllowance: amt(99_999_999), newValidUntil: iso(86_400_000) })]));
    ok("the operator cannot raise its own allowance", x.refused);
    const t = { sender: acct(ALICE), receiver: acct(BOB), amount: amt(3000), instrumentId: inst, requestedAt: iso(-30000), executeBefore: iso(3_600_000), inputHoldingCids: [h.contractId], meta: { values: {} } };
    const f = await fetch("http://127.0.0.1:18790/registry/transfer-instruction/v2/transfer-factory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ choiceArguments: { transfer: t } }) }).then(async (r) => ({ status: r.status, j: await r.json().catch(() => null) }));
    ok("registry answers for the governed admin", f.status === 200 && ["offer", "direct"].includes(f.j?.transferKind), `${f.status} ${f.j?.transferKind}`);
    const b0 = await total(BOB);
    await n.tx([ALICE], [ex(I_TF2, f.j.factoryId, "TransferFactory_Transfer", { transfer: t, actors: [ALICE], extraArgs: { context: f.j.choiceContext.choiceContextData, meta: { values: {} } } })], f.j.choiceContext.disclosedContracts);
    if (f.j.transferKind === "offer") {
      const p = (await waitFor(async () => (await n.acs(GOV, INSTR)).find((i) => i.createArgument.transfer.receiver === BOB))).v;
      await n.tx([BOB], [ex(I_TI2, p.contractId, "TransferInstruction_Accept", { actors: [BOB], extraArgs: noCtx })]);
    }
    await sleep(1500);
    ok("bob received 3000 micro", (await total(BOB)) === b0 + 3000);
  } finally { reg.kill(); }
});

await group("governed: revoke the operator (second proposal, again needs both nodes)", async () => {
  const [a] = await auth();
  if (!a) { ok("no authority left to revoke", false); return; }
  await n.tx([MEMBER], [{ CreateCommand: { templateId: G + "RevokeOperatorProposal", createArguments: { governanceParty: GOV, proposer: MEMBER, authorityCid: a.contractId } } }]);
  human("again: confirm on both nodes, then execute on t1", voteLines("YapRevokeOperator"));
  const w = await waitFor(async () => ((await auth()).length === 0 ? true : null), HUMAN);
  ok("the authority is gone after the governed revoke", !!w.v, `${w.s}s`);
  const x = await refused(() => n.tx([OP], [ex(OPA, a.contractId, "YapOperator_Mint", { recipient: ALICE, amount: amt(1) })]));
  ok("the revoked operator can mint nothing", x.refused);
});

const supply1 = await supplyNow();
ok("supply of the governed instance = exactly what the operator minted (5000 micro)", supply1 - supply0 === 5000, `${supply0} -> ${supply1} micro`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
