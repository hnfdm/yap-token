// What happens when ONE party holds more than 200 cUSDT holdings (dust spam)?
//  - the Ledger JSON API caps ACS answers at 200: who is affected (issuer snapshot, the party itself, the Wallet SDK)?
//  - can a party still spend ALL of them in one transaction (250 inputs)?
//  - does the SDK's merge consolidate a big pile?
// Uses a dedicated party `cusdt-dust` (1 micro-cUSDT x 250, then x 150). It keeps its (consolidated) 400 micro afterwards.
import { SDK } from "@canton-network/wallet-sdk";
import { getToken, ledger, acs, need, PKG } from "../scripts/lib.mjs";
import { T, mu, snapshot, supply, checkInvariants } from "../scripts/invariants.mjs";

const admin = need("CUSDT_ADMIN_PARTY");
const suffix = admin.split("::")[1];
const ALICE = `cusdt-alice::${suffix}`, DUST = `cusdt-dust::${suffix}`;
const REGISTRY = process.env.CUSDT_REGISTRY_URL || "https://registry-testnet.mahawallet.xyz";
const token = await getToken();
const auth = { method: "static", token };
const sdk = await (await SDK.create({ auth, ledgerClientUrl: need("LEDGER_URL") })).extend({ token: { auth, registries: [REGISTRY], registryAuth: "none" } });
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const short = (e) => String(e?.message ?? e).replace(/\s+/g, " ");
const IF_TF = "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory";
const IF_TI = "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction";

let pass = 0, fail = 0;
const ok = (n, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  — " + x : ""}`); };
const note = (s) => console.log(`      ${s}`);
const isCap = (m) => /MAXIMUM_LIST_ELEMENTS|413/i.test(m);

const tx = (actAs, commands, disclosed = []) => ledger(token, "/v2/commands/submit-and-wait-for-transaction", { method: "POST", json: {
  commands: { commands, commandId: `dust-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, actAs, readAs: actAs, disclosedContracts: disclosed },
  transactionFormat: { transactionShape: "TRANSACTION_SHAPE_LEDGER_EFFECTS", eventFormat: { filtersByParty: Object.fromEntries(actAs.map((p) => [p, {}])), verbose: true } } } });

// ---- the dust party ----------------------------------------------------------------------------
try { await ledger(token, "/v2/parties", { method: "POST", json: { partyIdHint: "cusdt-dust", identityProviderId: "" } }); note("created party cusdt-dust"); }
catch (e) { if (!/already|exists|ALREADY/i.test(short(e))) throw e; }
const userId = need("LEDGER_USER_ID");
await ledger(token, `/v2/users/${encodeURIComponent(userId)}/rights`, { method: "POST", json: { userId, identityProviderId: "",
  rights: [{ kind: { CanActAs: { value: { party: DUST } } } }, { kind: { CanReadAs: { value: { party: DUST } } } }] } });

async function mintDust(n) {
  const [adm] = await acs(token, admin, T.ADMIN); const cids = []; let cost = 0;
  for (let left = n; left > 0;) {
    const k = Math.min(50, left);
    const r = await tx([admin], Array.from({ length: k }, () => ({ ExerciseCommand: { templateId: T.ADMIN, contractId: adm.contractId, choice: "CusdtAdmin_Mint", choiceArgument: { recipient: DUST, amount: "0.0000010000" } } })));
    for (const e of r.transaction.events) if (e.ExercisedEvent?.choice === "CusdtAdmin_Mint") cids.push(e.ExercisedEvent.exerciseResult);
    cost = r.transaction.paidTrafficCost; left -= k;
  }
  note(`minted ${n} x 1 micro (last 50-mint batch: paidTrafficCost ${cost})`);
  return cids;
}
const sdkList = (extraOpts = {}) => sdk.token.utxos.list({ partyId: DUST, includeLocked: true, ...extraOpts });

// ---- baseline ----------------------------------------------------------------------------------
let S = await snapshot(token, admin);
const base = supply(S);
console.log(`start: supply ${base / 1e6}, ${S.H.length} holdings in total\n`);
const dust0 = S.H.filter((h) => h.createArgument.owner === DUST).length;
if (dust0 > 5) console.log(`note: ${DUST.slice(0, 14)}... already holds ${dust0} holdings from an earlier run`);

// ---- 250 dust holdings -------------------------------------------------------------------------
let cids = await mintDust(250);
let expected = base + 250;

try { await snapshot(token, admin); ok("issuer-side snapshot with 270 holdings", false, "unexpectedly worked"); }
catch (e) { ok("issuer (admin) can no longer list all holdings in one query", isCap(short(e)), short(e).slice(0, 90)); }

try { await acs(token, DUST, T.HOLDING); ok("the dust party's own ACS query", false, "unexpectedly worked"); }
catch (e) { ok("the party itself hits the cap too", isCap(short(e)), short(e).slice(0, 90)); }

// Observed 10 Oct 2026 (wallet-sdk 1.5.3): the DEFAULT list throws the 413 cap error once a party holds >200 holdings;
// `continueUntilCompletion: true` works. This is SDK behaviour, not cUSDT behaviour; if a newer SDK fixes it, this check flips.
try { const l = await sdkList(); ok("SDK default list throws on >200 holdings (use continueUntilCompletion)", false, `unexpectedly returned ${l.length}`); }
catch (e) { ok("SDK default list throws on >200 holdings (use continueUntilCompletion)", true, "threw the cap error as documented"); }
try { const all = await sdkList({ continueUntilCompletion: true }); ok("SDK list with continueUntilCompletion returns everything", all.length === 250, `${all.length} returned`); }
catch (e) { ok("SDK list with continueUntilCompletion returns everything", false, short(e).slice(0, 160)); }

// ---- spend all 250 in ONE transaction ----------------------------------------------------------
let bigOk = false;
try {
  const t = { sender: DUST, receiver: ALICE, amount: "0.0002500000", instrumentId: { admin, id: "cUSDT" }, requestedAt: iso(-30_000), executeBefore: iso(3_600_000), inputHoldingCids: cids, meta: { values: {} } };
  const f = await (await fetch(`${REGISTRY}/registry/transfer-instruction/v1/transfer-factory`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ choiceArguments: { expectedAdmin: admin, transfer: t } }) })).json();
  const r = await tx([DUST], [{ ExerciseCommand: { templateId: IF_TF, contractId: f.factoryId, choice: "TransferFactory_Transfer",
    choiceArgument: { expectedAdmin: admin, transfer: t, extraArgs: { context: f.choiceContext.choiceContextData, meta: { values: {} } } } } }], f.choiceContext.disclosedContracts);
  bigOk = true; note(`250-input transfer: paidTrafficCost ${r.transaction.paidTrafficCost}`);
  const instr = r.transaction.events.find((e) => e.CreatedEvent?.templateId?.endsWith(":CusdtTransferInstruction"))?.CreatedEvent;
  ok("one transaction can spend all 250 inputs", true, "accepted");
  if (instr) { await tx([DUST], [{ ExerciseCommand: { templateId: IF_TI, contractId: instr.contractId, choice: "TransferInstruction_Withdraw", choiceArgument: { extraArgs: { context: { values: {} }, meta: { values: {} } } } } }]); note("withdrawn again: the 250 dust holdings are now ONE holding"); }
} catch (e) { ok("one transaction can spend all 250 inputs", false, short(e).slice(0, 200)); }

// ---- 150 more, then let the SDK consolidate them -----------------------------------------------
cids = await mintDust(150); expected += 150;
let count = (await sdkList()).length;
note(`dust party now holds ${count} holdings (below the cap, so listing works again)`);
for (let i = 1; i <= 8 && count > 3; i++) {
  try {
    const [cmds, disclosed] = await sdk.token.utxos.merge({ partyId: DUST });
    if (!cmds?.length) { note("SDK merge: nothing to do"); break; }
    const r = await sdk.ledger.internal.submit({ commands: cmds, actAs: [DUST], readAs: [DUST], disclosedContracts: disclosed ?? [], commandId: `dust-merge-${Date.now()}-${i}` });
    const after = (await sdkList()).length;
    note(`SDK merge #${i}: ${count} -> ${after} holdings (${cmds.length} command(s))`);
    count = after;
  } catch (e) { note(`SDK merge #${i} failed: ${short(e).slice(0, 160)}`); break; }
}
ok("SDK merge consolidates the dust", count <= 3, `${count} holdings left`);

// ---- books must balance again ------------------------------------------------------------------
S = await snapshot(token, admin);
const v = checkInvariants(S, expected);
ok("issuer snapshot works again and conservation holds", v.length === 0, v.join("; ") || `supply ${supply(S) / 1e6}, ${S.H.length} holdings`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
