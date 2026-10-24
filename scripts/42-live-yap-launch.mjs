// LAUNCH of YAP with a FIXED SUPPLY of 100,000,000, issued once to the treasury of the decentralized governor (cusdt-gov, 2-of-2 over t1 + t2).
//   node scripts/42-live-yap-launch.mjs        (.env.testnet = t1; two HUMAN rounds on the VPSes, each = confirm-all on t1 + t2, execute-all on t1)
// Round 1: three GovernorMint proposals (60M + 20M + 20M, all to the governor itself) -> supply is exactly 100,000,000.
// Round 2: a vesting grant FROM the treasury (generic example schedule: 1,000,000 to alice, linear over 60 minutes) and a treasury transfer
//          (500,000 to bob, an offer that bob accepts). The supply must stay exactly 100,000,000 throughout. Then alice claims what has vested.
// The generic vesting numbers are placeholders for the real schedule, which is not final yet.
import { loadEnv } from "./lib.mjs";
import { node, waitFor, sleep } from "./nodes.mjs";

const E = loadEnv(".env.testnet"); if (E.INSECURE_TLS === "1") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const n = node(E, "t1");
const GOV = E.CUSDT_GOV_PARTY ?? "cusdt-gov::12205fb8f032bfcfe6ae4ae3a7625629fe9065668ee529e3a785691e1cdce5022c2b";
const MEMBER = E.CUSDT_GOV_MEMBER ?? "cryptolampung-testnet-1::122013397e0d9bb71891e884ccd6948a93057115a2fd46a5cf2e4db254844bbd0ea1";
const ALICE = E.CUSDT_ALICE, BOB = E.CUSDT_BOB;
const P = "#yap-token:YapToken:", G = "#yap-governance:YapGovernance:";
const HOLD = P + "YapHolding", ADM = P + "YapAdmin", VEST = P + "YapVesting", INSTR = P + "YapTransferInstruction";
const I_TI2 = "#splice-api-token-transfer-instruction-v2:Splice.Api.Token.TransferInstructionV2:TransferInstruction";
const short = (e) => String(e?.message ?? e).replace(/\s+/g, " ");
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const mu = (c) => Math.round(Number(c.createArgument.amount) * 1e6);
const amt = (m) => (m / 1e6).toFixed(10);
let pass = 0, fail = 0;
const ok = (m, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}  ${m}${x ? "  — " + x : ""}`); };
const ex = (templateId, contractId, choice, choiceArgument = {}) => ({ ExerciseCommand: { templateId, contractId, choice, choiceArgument } });
const noCtx = { context: { values: {} }, meta: { values: {} } };
const holdings = async () => n.acs(GOV, HOLD);
const free = async (p) => (await holdings()).filter((c) => c.createArgument.owner === p && c.createArgument.lock == null);
const total = async (p) => (await free(p)).reduce((s, c) => s + mu(c), 0);
const supplyNow = async () => (await holdings()).reduce((s, c) => s + mu(c), 0)
  + (await n.acs(GOV, INSTR)).reduce((s, i) => s + Math.round(Number(i.createArgument.transfer.amount) * 1e6), 0);
const HUMAN = 25 * 60_000;
const human = (what) => console.log(`\n   >>> HUMAN STEP (${what}), in /root on each VPS:\n       t1:  bash decman-vote-on-vps.sh confirm-all\n       t2:  bash decman-vote-on-vps.sh confirm-all\n       t1:  bash decman-vote-on-vps.sh execute-all\n   (waiting up to 25 minutes ...)\n`);
async function group(name, fn) { console.log(`-- ${name}`); try { await fn(); } catch (e) { fail++; console.log(`FAIL  ${name} threw: ${short(e).slice(0, 500)}`); } }
const create = (tpl, args) => n.tx([MEMBER], [{ CreateCommand: { templateId: G + tpl, createArguments: { governanceParty: GOV, proposer: MEMBER, ...args } } }]);

const [adm] = await n.acs(GOV, ADM), [tf] = await n.acs(GOV, P + "YapTransferFactory");
if (!adm || !tf) throw new Error("YapAdmin / YapTransferFactory of cusdt-gov not found: run decman-cusdt-on-vps.sh dars/accept-dars/contracts/accept-contracts first");
const SUPPLY = 100_000_000 * 1e6;
const s0 = await supplyNow();
console.log(`start: YAP supply ${s0 / 1e6}`);

await group("round 1: issue the whole supply once (three governed mints to the treasury)", async () => {
  if (s0 === 0) {
    for (const m of [60_000_000, 20_000_000, 20_000_000]) await create("GovernorMintProposal", { adminCid: adm.contractId, recipient: GOV, amount: amt(m * 1e6) });
    ok("three GovernorMintProposals created by t1's validator party", true);
    human("issue 100,000,000 YAP to the treasury");
    const w = await waitFor(async () => ((await supplyNow()) >= SUPPLY ? true : null), HUMAN);
    ok("the supply appeared after the governed execution", !!w.v, `${w.s}s`);
  } else console.log("(supply already issued, skipping round 1)");
  ok("supply is EXACTLY 100,000,000 YAP", (await supplyNow()) === SUPPLY, `${(await supplyNow()) / 1e6}`);
  ok("it all sits in the governor's treasury", (await total(GOV)) === SUPPLY);
});

let vestCid = null;
await group("round 2: vesting grant + treasury transfer, both funded from the treasury", async () => {
  const hs = (await free(GOV)).sort((a, b) => mu(a) - mu(b));
  if (hs.length < 2) throw new Error("need at least two treasury holdings (round 1 gives three)");
  const [h1, h2] = hs;                      // two different treasury holdings: the two proposals must not use the same input
  if ((await n.acs(GOV, VEST)).length === 0) {
    await create("GrantVestingFromTreasuryProposal", { adminCid: adm.contractId, treasuryCids: [h1.contractId], beneficiary: ALICE, amount: amt(1_000_000 * 1e6), start: iso(0), cliff: iso(0), finish: iso(60 * 60_000), revocable: true });
    await create("TreasuryTransferProposal", { factoryCid: tf.contractId, receiver: BOB, amount: amt(500_000 * 1e6), treasuryCids: [h2.contractId], executeBefore: iso(24 * 3_600_000) });
    ok("two proposals created (vesting 1,000,000 to alice; transfer 500,000 to bob)", true);
    human("fund the vesting and the transfer from the treasury");
    const w = await waitFor(async () => ((await n.acs(GOV, VEST)).length > 0 && (await n.acs(GOV, INSTR)).length > 0 ? true : null), HUMAN);
    ok("the vesting contract and the transfer offer appeared", !!w.v, `${w.s}s`);
  }
  ok("supply is STILL exactly 100,000,000 (offer pending + locked vesting + treasury)", (await supplyNow()) === SUPPLY, `${(await supplyNow()) / 1e6}`);
  const locked = (await holdings()).filter((c) => c.createArgument.owner === ALICE && c.createArgument.lock != null);
  ok("alice has 1,000,000 locked", locked.reduce((s, c) => s + mu(c), 0) === 1_000_000 * 1e6);
  const offer = (await n.acs(GOV, INSTR)).find((i) => i.createArgument.transfer.receiver === BOB);
  await n.tx([BOB], [ex(I_TI2, offer.contractId, "TransferInstruction_Accept", { actors: [BOB], extraArgs: noCtx })]);
  await sleep(2500);
  ok("bob accepted and holds 500,000", (await total(BOB)) === 500_000 * 1e6, `${(await total(BOB)) / 1e6}`);
  [vestCid] = (await n.acs(GOV, VEST)).map((v) => v.contractId);
});

await group("alice claims what has vested (linear, so a small slice after a few minutes)", async () => {
  await sleep(20_000);
  const a0 = await total(ALICE);
  await n.tx([ALICE], [ex(VEST, vestCid, "YapVesting_Claim", {})]);
  await sleep(2500);
  const got = (await total(ALICE)) - a0;
  ok("alice received a positive, partial amount", got > 0 && got < 1_000_000 * 1e6, `${got / 1e6} YAP`);
  ok("the supply is still exactly 100,000,000 after the claim", (await supplyNow()) === SUPPLY, `${(await supplyNow()) / 1e6}`);
  ok("the vesting contract still holds the unvested remainder locked", (await n.acs(GOV, VEST)).length === 1);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
