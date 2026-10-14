// Allocation_ExecuteTransfer when executor, sender AND receiver are all EXTERNAL (self-custodial) parties:
// one prepared transaction, three signatures. Also: missing / wrong signature must fail; executor == receiver (2 signatures).
// Keys live in sdk-test/.keys/ext-parties.json (git-ignored); the new executor party's key is saved BEFORE it is created.
import { SDK } from "@canton-network/wallet-sdk";
import { signTransactionHash } from "@canton-network/core-signing-lib";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { getToken, ledger, need } from "../scripts/lib.mjs";
import { snapshot, supply, checkInvariants } from "../scripts/invariants.mjs";

const admin = need("CUSDT_ADMIN_PARTY");
const REGISTRY = process.env.CUSDT_REGISTRY_URL || "https://registry-testnet.cryptolampung.space";
const token = await getToken();
const auth = { method: "static", token };
const sdk = await (await SDK.create({ auth, ledgerClientUrl: need("LEDGER_URL") })).extend({ token: { auth, registries: [REGISTRY], registryAuth: "none" } });
const asset = (await sdk.token.assets()).find((a) => a.id === "cUSDT");

// ---- parties + keys ----------------------------------------------------------------------------
const KEYFILE = new URL("./.keys/ext-parties.json", import.meta.url);
mkdirSync(new URL("./.keys/", import.meta.url), { recursive: true });
const saved = existsSync(KEYFILE) ? JSON.parse(readFileSync(KEYFILE, "utf8")) : {};
async function ensureParty(hint) {
  if (saved[hint]?.partyId) return saved[hint];
  const kp = sdk.keys.generate();
  saved[hint] = { publicKey: kp.publicKey, privateKey: kp.privateKey, partyId: null };
  writeFileSync(KEYFILE, JSON.stringify(saved, null, 1));
  const r = await sdk.party.external.create(kp.publicKey, { partyHint: hint }).sign(kp.privateKey).execute({ grantUserRights: true });
  saved[hint].partyId = r.partyId; writeFileSync(KEYFILE, JSON.stringify(saved, null, 1));
  console.log(`created external party ${r.partyId.slice(0, 40)}...`);
  return saved[hint];
}
const A = await ensureParty("cusdt-ext-alice"), B = await ensureParty("cusdt-ext-bob"), X = await ensureParty("cusdt-ext-exec");

// ---- helpers -----------------------------------------------------------------------------------
let n = 0;
const run = async (party, [cmd, disclosed]) => sdk.ledger.prepare({ partyId: party.partyId, commands: Array.isArray(cmd) ? cmd : [cmd], disclosedContracts: disclosed ?? [], commandId: `extal-${Date.now()}-${n++}` }).sign(party.privateKey).execute({ partyId: party.partyId });
const holdings = (p) => sdk.token.utxos.list({ partyId: p.partyId, includeLocked: true });
const total = (hs) => hs.reduce((s, h) => s + Math.round(Number(h.interfaceViewValue.amount) * 1e6), 0);
const lockedOf = (hs) => hs.filter((h) => h.interfaceViewValue.lock);
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const short = (e) => String(e?.message ?? e?.response?.data ?? e).replace(/\s+/g, " ");

/** prepare ONE transaction acted by several external parties, sign the same hash with each key, execute */
async function multiSigned(actAs, commands, disclosed, { signers = actAs, keyOverride = {}, tamper = false } = {}) {
  const prep = await sdk.ledger.internal.prepare({ commands, actAs: actAs.map((p) => p.partyId), readAs: [], disclosedContracts: disclosed ?? [], commandId: `extal-multi-${Date.now()}-${n++}` });
  const hash = prep.preparedTransactionHash;
  const sigs = signers.map((p) => ({ party: p.partyId, signatures: [{
    signature: signTransactionHash(hash, keyOverride[p.partyId] ?? p.privateKey), signedBy: p.partyId.split("::")[1],
    format: "SIGNATURE_FORMAT_CONCAT", signingAlgorithmSpec: "SIGNING_ALGORITHM_SPEC_ED25519" }] }));
  return ledger(token, "/v2/interactive-submission/executeAndWait", { method: "POST", json: {
    userId: need("LEDGER_USER_ID"), preparedTransaction: tamper ? prep.preparedTransaction.slice(0, -4) + "AAAA" : prep.preparedTransaction,
    hashingSchemeVersion: prep.hashingSchemeVersion, submissionId: `extal-${Date.now()}-${n++}`, deduplicationPeriod: { Empty: {} },
    partySignatures: { signatures: sigs } } });
}
const spec = (executor, sender, receiver, microAmount, ref) => ({
  settlement: { executor, settlementRef: { id: ref, cid: null }, requestedAt: iso(-30_000), allocateBefore: iso(3_600_000), settleBefore: iso(7_200_000), meta: { values: {} } },
  transferLegId: "leg-1", transferLeg: { sender, receiver, amount: (microAmount / 1e6).toFixed(10), instrumentId: { admin, id: "cUSDT" }, meta: { values: {} } } });
async function createAllocation(executor, microAmount) {
  const ref = `extal-${Date.now()}-${n++}`;
  await run(A, await sdk.token.allocation.instruction.create({ allocationSpecification: spec(executor.partyId, A.partyId, B.partyId, microAmount, ref), asset }));
  const pend = await sdk.token.allocation.pending(A.partyId);
  const found = pend.find((p) => p.interfaceViewValue.allocation.settlement.settlementRef.id === ref);
  if (!found) throw new Error("allocation not visible after creation");
  return found;
}
async function executeCommands(alloc) {   // what the SDK builds for Allocation_ExecuteTransfer
  const ex = await sdk.token.allocation.execute({ allocationCid: alloc.contractId, asset });
  return { cmd: ex.find((x) => x.ExerciseCommand), disclosed: ex.find(Array.isArray) ?? [] };
}

let pass = 0, fail = 0;
const ok = (name, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}  ${name}${x ? "  — " + x : ""}`); };
async function step(name, fn) { try { await fn(); } catch (e) { fail++; console.log(`FAIL  ${name}  — threw: ${short(e).slice(0, 400)}`); } }
async function mustFail(name, fn) { try { await fn(); ok(name, false, "unexpectedly succeeded"); } catch (e) { ok(name, true, `rejected: ${short(e).slice(-110)}`); } }

const S0 = await snapshot(token, admin); const expected = supply(S0);
const a0 = total(await holdings(A)), b0 = total(await holdings(B));
console.log(`ext-alice ${a0 / 1e6}, ext-bob ${b0 / 1e6}, executor ${X.partyId.slice(0, 30)}...\n`);
if (a0 < 10) throw new Error("ext-alice needs funds (run sdk-test/external.mjs first)");

// 1. all three external, three signatures
await step("3-party execute", async () => {
  const alloc = await createAllocation(X, 3);
  ok("allocation created by external sender with an EXTERNAL executor", lockedOf(await holdings(A)).length === 1);
  const { cmd, disclosed } = await executeCommands(alloc);
  await mustFail("only 2 of the 3 required signatures", () => multiSigned([X, A, B], [cmd], disclosed, { signers: [A, B] }));
  await mustFail("executor signs with the wrong key", () => multiSigned([X, A, B], [cmd], disclosed, { keyOverride: { [X.partyId]: B.privateKey } }));
  await mustFail("signature over a tampered transaction", () => multiSigned([X, A, B], [cmd], disclosed, { tamper: true }));
  ok("nothing moved after the failed attempts", total(await holdings(B)) === b0 && lockedOf(await holdings(A)).length === 1);
  await multiSigned([X, A, B], [cmd], disclosed);
  ok("execute with executor + sender + receiver signatures settles", total(await holdings(B)) === b0 + 3 && total(await holdings(A)) === a0 - 3 && lockedOf(await holdings(A)).length === 0, `bob +3 micro`);
});

// 2. executor == receiver: two signatures
await step("2-party execute (executor == receiver)", async () => {
  const alloc = await createAllocation(B, 2);
  const { cmd, disclosed } = await executeCommands(alloc);
  await multiSigned([B, A], [cmd], disclosed);
  ok("executor == receiver: sender + receiver signatures suffice", total(await holdings(B)) === b0 + 3 + 2 && lockedOf(await holdings(A)).length === 0);
});

// 3. cancel needs all three too; withdraw only the sender
await step("cancel / withdraw", async () => {
  let alloc = await createAllocation(X, 2);
  const cancel = await sdk.token.allocation.cancel({ allocationCid: alloc.contractId, asset });
  await mustFail("cancel with the sender's signature only", async () => run(A, cancel));
  await multiSigned([X, A, B], [cancel[0]], cancel[1]);
  ok("cancel signed by all three releases the funds", lockedOf(await holdings(A)).length === 0 && total(await holdings(A)) === a0 - 5);
  alloc = await createAllocation(X, 2);
  await run(A, await sdk.token.allocation.withdraw({ allocationCid: alloc.contractId, asset }));
  ok("withdraw by the sender alone (external signature)", lockedOf(await holdings(A)).length === 0 && total(await holdings(A)) === a0 - 5);
});

const v = checkInvariants(await snapshot(token, admin), expected);
ok("conservation invariants hold", v.length === 0, v.join("; "));
console.log(`\nend: ext-alice ${total(await holdings(A)) / 1e6}, ext-bob ${total(await holdings(B)) / 1e6}`);
console.log(`${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
