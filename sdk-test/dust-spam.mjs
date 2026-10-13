// Can an attacker (alice) push a victim (bob) past the 200-element API cap and break his wallet?
//  A) DIRECT dust: bob has a preapproval, alice sends ~200 transfers of 1 micro  -> ~200 tiny holdings at bob
//  B) INSTRUCTION spam: bob has no preapproval, alice opens ~200 pending 1-micro offers to him
// Measures what bob can still do, what it costs the attacker, and whether bob recovers. Cleanup runs in `finally`
// using contract ids captured at creation (the admin can't list >200 of anything while the spam exists).
import { SDK } from "@canton-network/wallet-sdk";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getToken, ledger, acs, need } from "../scripts/lib.mjs";
import { T, retrySend, snapshot, supply, checkInvariants } from "../scripts/invariants.mjs";

// The API cap is "more than 200 elements": N must be > 200 (plus whatever the victim already holds) to cross it.
const N = Number(process.argv[2] ?? 205), BATCH = 25;
const PHASES = (process.argv[3] ?? "AB").toUpperCase();   // e.g. "B" runs only the instruction spam
const admin = need("CUSDT_ADMIN_PARTY");
const suffix = admin.split("::")[1];
const ALICE = `cusdt-alice::${suffix}`, BOB = `cusdt-bob::${suffix}`;
const REGISTRY = process.env.CUSDT_REGISTRY_URL || "https://registry-testnet.airdropasc.com";
const token = await getToken();
const auth = { method: "static", token };
const sdk = await (await SDK.create({ auth, ledgerClientUrl: need("LEDGER_URL") })).extend({ token: { auth, registries: [REGISTRY], registryAuth: "none" } });
const IF_TF = "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory";
const IF_TI = "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction";
const extra = { extraArgs: { context: { values: {} }, meta: { values: {} } } };
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const short = (e) => String(e?.message ?? e?.response?.data ?? e).replace(/\s+/g, " ");
const isCap = (m) => /MAXIMUM_LIST_ELEMENTS|413/i.test(m);
let n = 0, pass = 0, fail = 0;
const ok = (name, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}  ${name}${x ? "  — " + x : ""}`); };
const note = (s) => console.log(`      ${s}`);

/** one transaction with many commands; returns the created events of the given parties + traffic cost */
async function tx(actAs, commands, disclosed = [], see = [ALICE, BOB]) {
  const r = await retrySend(() => ledger(token, "/v2/commands/submit-and-wait-for-transaction", { method: "POST", json: {
    commands: { commands, commandId: `dust-${Date.now()}-${n++}`, actAs, readAs: actAs, disclosedContracts: disclosed },
    transactionFormat: { transactionShape: "TRANSACTION_SHAPE_LEDGER_EFFECTS", eventFormat: { filtersByParty: Object.fromEntries(see.map((p) => [p, {}])), verbose: true } } } }));
  const created = r.transaction.events.filter((e) => e.CreatedEvent).map((e) => e.CreatedEvent);
  return { created, cost: r.transaction.paidTrafficCost, exercised: r.transaction.events.filter((e) => e.ExercisedEvent).map((e) => e.ExercisedEvent) };
}
async function mintToAlice(count) {                     // 1-micro holdings for the attacker; returns their contract ids
  const [adm] = await acs(token, admin, T.ADMIN); const cids = [];
  for (let left = count; left > 0;) { const k = Math.min(50, left);
    const r = await tx([admin], Array.from({ length: k }, () => ({ ExerciseCommand: { templateId: T.ADMIN, contractId: adm.contractId, choice: "CusdtAdmin_Mint", choiceArgument: { recipient: ALICE, amount: "0.0000010000" } } })), [], [admin]);
    cids.push(...r.exercised.filter((e) => e.choice === "CusdtAdmin_Mint").map((e) => e.exerciseResult)); left -= k; }
  return cids;
}
/** alice sends 1 micro to bob once per source holding, BATCH per transaction */
async function sendMany(srcCids) {
  const created = []; let cost = 0, txs = 0;
  for (let i = 0; i < srcCids.length; i += BATCH) {
    const part = srcCids.slice(i, i + BATCH);
    const t = { sender: ALICE, receiver: BOB, amount: "0.0000010000", instrumentId: { admin, id: "cUSDT" }, requestedAt: iso(-30_000), executeBefore: iso(3_600_000), inputHoldingCids: [part[0]], meta: { values: {} } };
    const f = await (await fetch(`${REGISTRY}/registry/transfer-instruction/v1/transfer-factory`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ choiceArguments: { expectedAdmin: admin, transfer: t } }) })).json();
    const cmds = part.map((cid) => ({ ExerciseCommand: { templateId: IF_TF, contractId: f.factoryId, choice: "TransferFactory_Transfer",
      choiceArgument: { expectedAdmin: admin, transfer: { ...t, inputHoldingCids: [cid] }, extraArgs: { context: f.choiceContext.choiceContextData, meta: { values: {} } } } } }));
    const r = await tx([ALICE], cmds, f.choiceContext.disclosedContracts); created.push(...r.created); cost += Number(r.cost); txs++;
  }
  return { created, cost, txs };
}
const balBob = async () => (await sdk.token.utxos.list({ partyId: BOB, includeLocked: true, continueUntilCompletion: true })).reduce((s, h) => s + Math.round(Number(h.interfaceViewValue.amount) * 1e6), 0);

const S0 = await snapshot(token, admin); let expected = supply(S0);
note(`start: supply ${expected / 1e6}, ${S0.H.length} holdings, bob ${await balBob()} micro`);
const dustCids = [], instrCids = []; let bobHadPre = null;

try {
  // ============ A. direct dust ============
  if (PHASES.includes("A")) {
  console.log("\n-- A. direct dust spam (bob has a preapproval)");
  const [adm] = await acs(token, admin, T.ADMIN);
  const pre0 = (await acs(token, admin, T.PRE)).filter((c) => c.createArgument.receiver === BOB);
  if (!pre0.length) await tx([admin], [{ ExerciseCommand: { templateId: T.ADMIN, contractId: adm.contractId, choice: "CusdtAdmin_CreatePreapproval", choiceArgument: { receiver: BOB } } }], [], [admin]);
  bobHadPre = pre0.length > 0;
  const srcA = await mintToAlice(N); expected += N;
  const a = await sendMany(srcA);
  const bobDust = a.created.filter((c) => c.templateId.endsWith(":CusdtHolding") && c.createArgument?.owner === BOB);
  dustCids.push(...bobDust.map((c) => c.contractId));
  note(`attacker: ${a.txs} transactions, paidTrafficCost ${a.cost} for ${bobDust.length} dust holdings at bob (~${Math.round(a.cost / Math.max(1, bobDust.length))} per holding)`);
  ok(`the preapproval let ${bobDust.length} unrequested holdings land at bob`, bobDust.length === N);

  try { await acs(token, BOB, T.HOLDING); ok("bob's own ACS query", false, "unexpectedly worked"); } catch (e) { ok("bob's own ACS query hits the 413 cap", isCap(short(e))); }
  try { const l = await sdk.token.utxos.list({ partyId: BOB, includeLocked: true }); ok("SDK default list for bob", false, `unexpectedly returned ${l.length}`); } catch (e) { ok("SDK default list for bob throws", true); }
  let spendAuto = "ok"; try { await sdk.token.transfer.create({ sender: BOB, recipient: ALICE, amount: "0.000001", instrumentId: "cUSDT", registryUrl: REGISTRY }); } catch (e) { spendAuto = short(e).slice(0, 140); }
  ok("FINDING: can bob start a transfer with automatic input selection?", true, spendAuto === "ok" ? "yes (the SDK handles it)" : `NO — ${spendAuto}`);
  let spendExplicit = "ok"; try { await sdk.token.transfer.create({ sender: BOB, recipient: ALICE, amount: "0.000001", instrumentId: "cUSDT", registryUrl: REGISTRY, inputUtxos: [dustCids[0]] }); } catch (e) { spendExplicit = short(e).slice(0, 140); }
  ok("bob CAN still spend when he names the input holding himself", spendExplicit === "ok", spendExplicit);

  // recovery with the standard wallet tool
  let rounds = 0, left = null;
  for (; rounds < 8; rounds++) {
    try { const [cmds, disc] = await sdk.token.utxos.merge({ partyId: BOB });
      if (!cmds?.length) break;
      await sdk.ledger.internal.submit({ commands: cmds, actAs: [BOB], readAs: [BOB], disclosedContracts: disc ?? [], commandId: `dust-merge-${Date.now()}-${rounds}` });
    } catch (e) { note(`SDK merge round ${rounds + 1} failed: ${short(e).slice(0, 160)}`); break; }
    left = (await sdk.token.utxos.list({ partyId: BOB, includeLocked: true, continueUntilCompletion: true })).length; if (left <= 3) { rounds++; break; }
  }
  left ??= (await sdk.token.utxos.list({ partyId: BOB, includeLocked: true, continueUntilCompletion: true })).length;
  ok("bob recovers with the SDK's own merge", left <= 3, `${rounds} merge round(s), ${left} holding(s) left`);

  }
  // ============ B. instruction spam ============
  if (PHASES.includes("B")) {
  console.log("\n-- B. instruction spam (no preapproval at bob)");
  for (const c of (await acs(token, admin, T.PRE)).filter((c) => c.createArgument.receiver === BOB))
    await tx([BOB], [{ ExerciseCommand: { templateId: T.PRE, contractId: c.contractId, choice: "CusdtTransferPreapproval_Cancel", choiceArgument: {} } }], [], [BOB]);
  const srcB = await mintToAlice(N); expected += N;
  const b = await sendMany(srcB);
  const insts = b.created.filter((c) => c.templateId.endsWith(":CusdtTransferInstruction"));
  instrCids.push(...insts.map((c) => c.contractId));
  note(`attacker: ${b.txs} transactions, paidTrafficCost ${b.cost} for ${insts.length} pending offers (~${Math.round(b.cost / Math.max(1, insts.length))} each); the 1-micro funds stay recoverable by the attacker`);
  ok(`${insts.length} unrequested pending offers now sit at bob`, insts.length === N);
  try { await acs(token, BOB, T.INSTR); ok("bob's raw instruction ACS", false, "unexpectedly worked"); } catch (e) { ok("bob's raw instruction ACS hits the 413 cap", isCap(short(e))); }
  let pend = null; try { pend = await sdk.token.transfer.pending(BOB); } catch (e) { pend = short(e).slice(0, 120); }
  ok("FINDING: can bob's wallet list his incoming offers at all?", true, Array.isArray(pend) ? `yes (${pend.length})` : `NO — ${pend}`);
  }
} finally {
  // ============ cleanup ============
  console.log("\n-- cleanup");
  for (let i = 0; i < instrCids.length; i += 50) {
    try { await tx([ALICE], instrCids.slice(i, i + 50).map((cid) => ({ ExerciseCommand: { templateId: IF_TI, contractId: cid, choice: "TransferInstruction_Withdraw", choiceArgument: extra } })), [], [ALICE]); }
    catch (e) { note("withdraw batch failed: " + short(e).slice(0, 120)); }
  }
  for (const c of (await acs(token, admin, T.PRE).catch(() => [])).filter((c) => c.createArgument.receiver === BOB))
    if (bobHadPre === false) await tx([BOB], [{ ExerciseCommand: { templateId: T.PRE, contractId: c.contractId, choice: "CusdtTransferPreapproval_Cancel", choiceArgument: {} } }], [], [BOB]).catch(() => {});
  // consolidate whatever is left with the contract's own Merge (dust-cleanup.mjs; more reliable than the SDK's merge),
  // which also cancels bob's preapproval, so the issuer-side checks work again
  for (const who of ["cusdt-alice", "cusdt-bob"]) {
    try { execFileSync(process.execPath, [fileURLToPath(new URL("./dust-cleanup.mjs", import.meta.url)), who], { env: process.env, timeout: 420_000 }).toString().split("\n").filter((l) => /holds|round|cancelled/.test(l)).forEach((l) => note(l)); }
    catch (e) { note(`cleanup for ${who} failed: ${short(e).slice(0, 140)}`); }
  }
  // fresh token: this script can outlive the 5-minute one it started with
  try { const v = checkInvariants(await snapshot(await getToken(), admin), expected); ok("books balance again after cleanup", v.length === 0, v.join("; ") || "conservation holds"); }
  catch (e) { ok("books balance again after cleanup", false, short(e).slice(0, 160)); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}
