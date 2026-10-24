// Allocates the YAP treasury of the decentralized governor (cusdt-gov) following the tokenomics draft v1.3, as ONE governed decision.
//   node scripts/43-live-yap-allocation.mjs        (.env.testnet = t1; ONE human round on the VPSes: confirm-all on t1 + t2, execute-all on t1)
// 9 pool parties (yap-pool-*, hosted on t1) receive their TGE share at once and the rest as linear vesting (month = 30 days, vesting starts
// after the cliff). Nothing is minted: the supply must stay EXACTLY 100,000,000.
//
//   pool        total   TGE      cliff  vesting after the cliff
//   airdrop     15M     1.5M     0      6 months
//   creator     22M     0        0      yearly slices 8M / 6M / 4.5M / 3.5M (months 0-12, 12-24, 24-36, 36-48)
//   staking      7M     0        0      36 months
//   ecosystem   10M     0.5M     1      36 months
//   liquidity    8M     4M       0      12 months
//   marketing    5M     0.25M    1      18 months
//   treasury    15M     0        12     36 months   (13.5M on THIS instance: 1.5M of test tokens went out of it before the schedule)
//   team        15M     0        12     36 months
//   advisors     3M     0        6      18 months
//
// Differences to the document, on purpose: vesting is continuous (per second) instead of equal monthly portions, and no grant is revocable.
import { appendFileSync } from "node:fs";
import { loadEnv } from "./lib.mjs";
import { node, waitFor, sleep } from "./nodes.mjs";

const E = loadEnv(".env.testnet"); if (E.INSECURE_TLS === "1") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const n = node(E, "t1");
const GOV = E.CUSDT_GOV_PARTY ?? "cusdt-gov::12205fb8f032bfcfe6ae4ae3a7625629fe9065668ee529e3a785691e1cdce5022c2b";
const MEMBER = E.CUSDT_GOV_MEMBER ?? "cryptolampung-testnet-1::122013397e0d9bb71891e884ccd6948a93057115a2fd46a5cf2e4db254844bbd0ea1";
const P = "#yap-token:YapToken:", G = "#yap-governance:YapGovernance:";
const HOLD = P + "YapHolding", VEST = P + "YapVesting";
const short = (e) => String(e?.message ?? e).replace(/\s+/g, " ");
const mu = (c) => Math.round(Number(c.createArgument.amount) * 1e6);
const amt = (m) => (m / 1e6).toFixed(10);
const YAP = 1e6;                                   // micro per YAP
const MONTH = 30 * 24 * 3600 * 1000;
let pass = 0, fail = 0;
const ok = (m, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}  ${m}${x ? "  — " + x : ""}`); };
const ex = (templateId, contractId, choice, choiceArgument = {}) => ({ ExerciseCommand: { templateId, contractId, choice, choiceArgument } });
const refused = async (fn) => { try { await fn(); return { refused: false, msg: "ACCEPTED" }; } catch (e) { return { refused: true, msg: short(e) }; } };
const HUMAN = 25 * 60_000;
async function group(name, fn) { console.log(`-- ${name}`); try { await fn(); } catch (e) { fail++; console.log(`FAIL  ${name} threw: ${short(e).slice(0, 600)}`); } }

// ---- the nine pool parties (created once, hosted on t1, rights for the ledger user) ----
const POOLS = ["airdrop", "creator", "staking", "ecosystem", "liquidity", "marketing", "treasury", "team", "advisors"];
const pool = {};
await group("pool parties", async () => {
  const existing = (await n.ledger("/v2/parties")).partyDetails ?? [];
  for (const name of POOLS) {
    const key = `YAP_POOL_${name.toUpperCase()}`;
    let party = E[key] ?? existing.find((p) => p.party.startsWith(`yap-pool-${name}::`))?.party;
    if (!party) {
      party = (await n.ledger("/v2/parties", { method: "POST", json: { partyIdHint: `yap-pool-${name}`, identityProviderId: "" } })).partyDetails.party;
      await n.ledger(`/v2/users/${encodeURIComponent(E.LEDGER_USER_ID)}/rights`, { method: "POST", json: { userId: E.LEDGER_USER_ID, identityProviderId: "",
        rights: [{ kind: { CanActAs: { value: { party } } } }, { kind: { CanReadAs: { value: { party } } } }] } });
      appendFileSync(new URL("../.env.testnet", import.meta.url), `\n${key}=${party}\n`);
      console.log(`      created ${party.split("::")[0]}`);
    }
    pool[name] = party;
  }
  ok("nine pool parties exist and the ledger user can act as them", POOLS.every((p) => !!pool[p]));
});

const holdings = async () => n.acs(GOV, HOLD);
const supplyNow = async () => (await holdings()).reduce((s, c) => s + mu(c), 0);
const free = (hs, p) => hs.filter((c) => c.createArgument.owner === p && c.createArgument.lock == null).reduce((s, c) => s + mu(c), 0);
const locked = (hs, p) => hs.filter((c) => c.createArgument.owner === p && c.createArgument.lock != null).reduce((s, c) => s + mu(c), 0);
const SUPPLY = 100_000_000 * YAP;
const hs0 = await holdings();
const treasury = hs0.filter((c) => c.createArgument.owner === GOV && c.createArgument.lock == null);
const treasuryTotal = treasury.reduce((s, c) => s + mu(c), 0);
console.log(`start: supply ${(await supplyNow()) / YAP}, governor treasury ${treasuryTotal / YAP} YAP in ${treasury.length} holding(s)`);

// ---- the schedule ----
const t0 = Date.now();
const at = (months) => new Date(t0 + months * MONTH).toISOString();
const rel = (who, y) => ({ tag: "ReleaseItem", value: { receiver: pool[who], amount: amt(y * YAP) } });
const vest = (who, y, fromM, toM) => ({ tag: "VestItem", value: { beneficiary: pool[who], amount: amt(y * YAP), start: at(fromM), cliff: at(fromM), finish: at(toM), revocable: false } });
const others = [
  rel("airdrop", 1_500_000), rel("ecosystem", 500_000), rel("liquidity", 4_000_000), rel("marketing", 250_000),
  vest("airdrop", 13_500_000, 0, 6),
  vest("creator", 8_000_000, 0, 12), vest("creator", 6_000_000, 12, 24), vest("creator", 4_500_000, 24, 36), vest("creator", 3_500_000, 36, 48),
  vest("staking", 7_000_000, 0, 36),
  vest("ecosystem", 9_500_000, 1, 37),
  vest("liquidity", 4_000_000, 0, 12),
  vest("marketing", 4_750_000, 1, 19),
  vest("team", 15_000_000, 12, 48),
  vest("advisors", 3_000_000, 6, 24),
];
const othersTotal = others.reduce((s, i) => s + Math.round(Number(i.value.amount) * YAP), 0);
const treasuryShare = treasuryTotal - othersTotal;                // what is left for the Treasury / Foundation pool
const EXPECT_TREASURY = 13_500_000 * YAP;
const items = [...others, vest("treasury", treasuryShare / YAP, 12, 48)];
console.log(`treasury / foundation share = ${treasuryShare / YAP} YAP (the document says 15M; ${EXPECT_TREASURY / YAP}M here because 1.5M of test tokens left the treasury earlier)`);

const EXPECT = { airdrop: 15_000_000, creator: 22_000_000, staking: 7_000_000, ecosystem: 10_000_000, liquidity: 8_000_000, marketing: 5_000_000, treasury: treasuryShare / YAP, team: 15_000_000, advisors: 3_000_000 };
const TGE_FREE = { airdrop: 1_500_000, ecosystem: 500_000, liquidity: 4_000_000, marketing: 250_000 };

await group("one governed allocation decision (propose -> t1 + t2 confirm -> execute)", async () => {
  if ((await n.acs(GOV, VEST)).some((v) => Object.values(pool).includes(v.createArgument.beneficiary))) { console.log("(pool vestings already exist, skipping the proposal)"); return; }
  if (treasuryShare < 12_000_000 * YAP || treasuryShare > 15_000_000 * YAP) throw new Error(`unexpected treasury share ${treasuryShare / YAP}: the treasury is not what this script assumes, check it first`);
  await n.tx([MEMBER], [{ CreateCommand: { templateId: G + "AllocationProposal", createArguments: { governanceParty: GOV, proposer: MEMBER, treasuryCids: treasury.map((c) => c.contractId), items, purpose: "YAP tokenomics v1.3 allocation" } } }]);
  ok(`AllocationProposal created: ${items.length} items, ${items.reduce((s, i) => s + Math.round(Number(i.value.amount) * YAP), 0) / YAP} YAP`, true);
  console.log(`\n   >>> HUMAN STEP, in /root on each VPS (confirm-all PRINTS every item first: check the pools and amounts, Ctrl+C aborts):\n       t1:  bash decman-vote-on-vps.sh confirm-all\n       t2:  bash decman-vote-on-vps.sh confirm-all\n       t1:  bash decman-vote-on-vps.sh execute-all\n   (waiting up to 25 minutes ...)\n`);
  const w = await waitFor(async () => ((await n.acs(GOV, VEST)).filter((v) => Object.values(pool).includes(v.createArgument.beneficiary)).length >= 12 ? true : null), HUMAN);
  ok("the vesting schedules appeared after the governed execution", !!w.v, `${w.s}s`);
  await sleep(2000);
});

await group("the result matches the document", async () => {
  const hs = await holdings();
  ok("supply is STILL exactly 100,000,000 YAP", (await supplyNow()) === SUPPLY, `${(await supplyNow()) / YAP}`);
  ok("the treasury has nothing left", free(hs, GOV) === 0, `${free(hs, GOV) / YAP}`);
  for (const name of POOLS) {
    const got = free(hs, pool[name]) + locked(hs, pool[name]);
    ok(`${name.padEnd(9)} holds ${(EXPECT[name] / 1e6).toFixed(2)}M`, got === Math.round(EXPECT[name] * YAP), `${got / YAP}`);
  }
  for (const [name, y] of Object.entries(TGE_FREE)) ok(`${name.padEnd(9)} TGE share ${y / 1e6}M is free to use`, free(hs, pool[name]) === y * YAP, `${free(hs, pool[name]) / YAP}`);
  const tge = POOLS.reduce((s, p) => s + free(hs, pool[p]), 0);
  ok("circulating at TGE from the pools = 6,250,000 YAP (as in the document)", tge === 6_250_000 * YAP, `${tge / YAP}`);
  const vs = (await n.acs(GOV, VEST)).filter((v) => Object.values(pool).includes(v.createArgument.beneficiary));
  ok("12 vesting schedules, none revocable", vs.length === 12 && vs.every((v) => v.createArgument.revocable === false), `${vs.length}`);
});

await group("vesting behaves: the team cannot claim before its cliff, the airdrop pool can claim a little right away", async () => {
  const vs = (await n.acs(GOV, VEST)).filter((v) => Object.values(pool).includes(v.createArgument.beneficiary));
  const of = (name) => vs.filter((v) => v.createArgument.beneficiary === pool[name]);
  const team = of("team")[0], air = of("airdrop")[0];
  const x = await refused(() => n.tx([pool.team], [ex(VEST, team.contractId, "YapVesting_Claim", {})]));
  ok("team claim before the 12-month cliff is refused", x.refused, x.msg.slice(-100));
  await sleep(15_000);
  const before = free(await holdings(), pool.airdrop);
  await n.tx([pool.airdrop], [ex(VEST, air.contractId, "YapVesting_Claim", {})]);
  await sleep(2500);
  const got = free(await holdings(), pool.airdrop) - before;
  ok("the airdrop pool received a small positive amount", got > 0 && got < 13_500_000 * YAP, `${got / YAP} YAP`);
  ok("supply still exactly 100,000,000 after the claim", (await supplyNow()) === SUPPLY);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
