// Recover from a dust-spam run (or any pile of tiny holdings): cancel bob's preapproval if present, then consolidate
// every holding of the given party with the contract's own Merge choice, 50 per command, in rounds.
//   node dust-cleanup.mjs [party-hint=cusdt-bob]
import { SDK } from "@canton-network/wallet-sdk";
import { getToken, ledger, acs, need } from "../scripts/lib.mjs";
import { T, retry, retrySend, snapshot, supply, checkInvariants } from "../scripts/invariants.mjs";

const admin = need("CUSDT_ADMIN_PARTY");
const suffix = admin.split("::")[1];
const party = `${process.argv[2] ?? "cusdt-bob"}::${suffix}`;
const BOB = `cusdt-bob::${suffix}`;
const REGISTRY = process.env.CUSDT_REGISTRY_URL || "https://registry-testnet.cryptolampung.space";
const token = await getToken();
const auth = { method: "static", token };
const sdk = await (await SDK.create({ auth, ledgerClientUrl: need("LEDGER_URL") })).extend({ token: { auth, registries: [REGISTRY], registryAuth: "none" } });
let n = 0;
const tx = (actAs, commands) => retrySend(() => ledger(token, "/v2/commands/submit-and-wait-for-transaction", { method: "POST", json: {
  commands: { commands, commandId: `cleanup-${Date.now()}-${n++}`, actAs, readAs: actAs },
  transactionFormat: { transactionShape: "TRANSACTION_SHAPE_LEDGER_EFFECTS", eventFormat: { filtersByParty: Object.fromEntries(actAs.map((p) => [p, {}])), verbose: true } } } }));
const listAll = () => retry(async () => (await sdk.token.utxos.list({ partyId: party, includeLocked: true, continueUntilCompletion: true })));
const free = (hs) => hs.filter((h) => !h.interfaceViewValue.lock);

// 1. the spam test's preapproval for bob
for (const c of (await retry(() => acs(token, admin, T.PRE))).filter((c) => c.createArgument.receiver === BOB)) {
  await retry(() => tx([BOB], [{ ExerciseCommand: { templateId: T.PRE, contractId: c.contractId, choice: "CusdtTransferPreapproval_Cancel", choiceArgument: {} } }]));
  console.log("cancelled bob's preapproval");
}

// 2. consolidate
let hs = free(await listAll());
console.log(`${party.split("::")[0]} holds ${hs.length} free holdings, total ${hs.reduce((s, h) => s + Math.round(Number(h.interfaceViewValue.amount) * 1e6), 0)} micro`);
for (let round = 1; hs.length > 1 && round <= 6; round++) {
  const chunks = []; for (let i = 0; i < hs.length; i += 50) chunks.push(hs.slice(i, i + 50)).valueOf();
  const cmds = chunks.filter((c) => c.length > 1).map((c) => ({ ExerciseCommand: { templateId: T.HOLDING, contractId: c[0].contractId, choice: "CusdtHolding_Merge", choiceArgument: { otherCids: c.slice(1).map((h) => h.contractId) } } }));
  if (!cmds.length) break;
  const r = await retry(() => tx([party], cmds), 3);
  console.log(`round ${round}: ${hs.length} -> ${chunks.length} holdings (${cmds.length} merge command(s), paidTrafficCost ${r.transaction.paidTrafficCost})`);
  hs = free(await listAll());
}
console.log(`${party.split("::")[0]} now holds ${hs.length} free holding(s)`);

// 3. are the books balanced?
try {
  const S = await snapshot(token, admin);
  console.log(`issuer snapshot works again: ${S.H.length} holdings, ${S.I.length} pending, ${S.A.length} allocations, supply ${supply(S) / 1e6}`);
  const v = checkInvariants(S, supply(S));   // structural invariants only (I2-I5); supply is reported above
  console.log(v.length ? "STRUCTURAL INVARIANTS BROKEN: " + v.join("; ") : "structural invariants hold");
} catch (e) { console.log("issuer snapshot still failing: " + String(e.message).slice(0, 140)); process.exitCode = 1; }
