// External (self-custodial) parties through the official Wallet SDK: the path real wallets use.
// Every submission is  prepare -> sign locally with the party's own key -> execute  (no actAs, no admin token).
// Keys are saved to sdk-test/.keys/ (git-ignored) BEFORE the party is created: never lose a party's key.
import { SDK } from "@canton-network/wallet-sdk";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { getToken, need, acs, submit as rawSubmit, PKG } from "../scripts/lib.mjs";

const admin = need("CUSDT_ADMIN_PARTY");
const REGISTRY = process.env.CUSDT_REGISTRY_URL || "https://registry-testnet.cryptolampung.space";
const token = await getToken();
const auth = { method: "static", token };
const sdk = await (await SDK.create({ auth, ledgerClientUrl: need("LEDGER_URL") }))
  .extend({ token: { auth, registries: [REGISTRY], registryAuth: "none" } });
const asset = (await sdk.token.assets()).find((a) => a.id === "YAP");

// ---- parties + keys (persisted) ------------------------------------------------------------
const KEYFILE = new URL("./.keys/ext-parties.json", import.meta.url);
mkdirSync(new URL("./.keys/", import.meta.url), { recursive: true });
const saved = existsSync(KEYFILE) ? JSON.parse(readFileSync(KEYFILE, "utf8")) : {};
async function ensureParty(hint) {
  if (saved[hint]?.partyId) return saved[hint];
  const kp = sdk.keys.generate();
  saved[hint] = { publicKey: kp.publicKey, privateKey: kp.privateKey, partyId: null };
  writeFileSync(KEYFILE, JSON.stringify(saved, null, 1));          // key first, party second
  const r = await sdk.party.external.create(kp.publicKey, { partyHint: hint }).sign(kp.privateKey).execute({ grantUserRights: true });
  saved[hint].partyId = r.partyId;
  writeFileSync(KEYFILE, JSON.stringify(saved, null, 1));
  console.log(`created external party ${r.partyId.slice(0, 40)}...`);
  return saved[hint];
}
const A = await ensureParty("cusdt-ext-alice"), B = await ensureParty("cusdt-ext-bob");

// ---- helpers --------------------------------------------------------------------------------
let n = 0;
/** prepare -> sign -> execute for an external party; `prepared` = [command(s), disclosedContracts] */
const run = async (party, [cmd, disclosed]) =>
  sdk.ledger.prepare({ partyId: party.partyId, commands: Array.isArray(cmd) ? cmd : [cmd], disclosedContracts: disclosed ?? [], commandId: `ext-${Date.now()}-${n++}` })
    .sign(party.privateKey).execute({ partyId: party.partyId });
const holdings = (p) => sdk.token.utxos.list({ partyId: p.partyId, includeLocked: true });
const total = (hs) => hs.reduce((s, h) => s + Number(h.interfaceViewValue.amount), 0);
const xfer = (from, to, amount) => sdk.token.transfer.create({ sender: from.partyId, recipient: to.partyId, amount: String(amount), instrumentId: "YAP", registryUrl: REGISTRY });

let pass = 0, fail = 0;
const ok = (name, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}  ${name}${x ? "  — " + x : ""}`); };
async function step(name, fn) { try { await fn(); } catch (e) { fail++; console.log(`FAIL  ${name}  — threw: ${String(e.message).replace(/\s+/g, " ").slice(0, 400)}`); } }

console.log(`ext-alice ${A.partyId.slice(0, 32)}...\next-bob   ${B.partyId.slice(0, 32)}...\n`);

// ---- fund alice (issuer mints; this is the only admin-token step) ---------------------------
await step("fund", async () => {
  if (total(await holdings(A)) >= 20) return;
  const [adm] = await acs(token, admin, `${PKG}:CusdtToken:CusdtAdmin`);
  await rawSubmit(token, { actAs: [admin], label: "ext-mint", commands: [{ ExerciseCommand: { templateId: `${PKG}:CusdtToken:CusdtAdmin`,
    contractId: adm.contractId, choice: "CusdtAdmin_Mint", choiceArgument: { recipient: A.partyId, amount: "50.0000000000" } } }] });
});
const A0 = total(await holdings(A)), B0 = total(await holdings(B));
console.log(`start: ext-alice ${A0}, ext-bob ${B0}\n`);

await step("offer + accept", async () => {
  await run(A, await xfer(A, B, 2));
  const pend = await sdk.token.transfer.pending(B.partyId);
  ok("pending instruction visible to external bob", pend.length === 1 && Number(pend[0].interfaceViewValue.transfer.amount) === 2);
  await run(B, await sdk.token.transfer.accept({ transferInstructionCid: pend[0].contractId, registryUrl: REGISTRY }));
  ok("accept signed by bob's own key moves 2", total(await holdings(A)) === A0 - 2 && total(await holdings(B)) === B0 + 2);
});

await step("reject + withdraw", async () => {
  await run(A, await xfer(A, B, 1));
  let pend = await sdk.token.transfer.pending(B.partyId);
  await run(B, await sdk.token.transfer.reject({ transferInstructionCid: pend[0].contractId, registryUrl: REGISTRY }));
  ok("reject by external receiver returns funds", total(await holdings(A)) === A0 - 2);
  await run(A, await xfer(A, B, 1));
  pend = await sdk.token.transfer.pending(B.partyId);
  await run(A, await sdk.token.transfer.withdraw({ transferInstructionCid: pend[0].contractId, registryUrl: REGISTRY }));
  ok("withdraw by external sender returns funds", total(await holdings(A)) === A0 - 2 && (await sdk.token.transfer.pending(B.partyId)).length === 0);
});

await step("direct transfer", async () => {
  const [adm] = await acs(token, admin, `${PKG}:CusdtToken:CusdtAdmin`);
  await rawSubmit(token, { actAs: [admin], label: "ext-pre", commands: [{ ExerciseCommand: { templateId: `${PKG}:CusdtToken:CusdtAdmin`,
    contractId: adm.contractId, choice: "CusdtAdmin_CreatePreapproval", choiceArgument: { receiver: B.partyId } } }] });
  await run(A, await xfer(A, B, 1));
  ok("direct to preapproved external receiver", total(await holdings(B)) === B0 + 3 && (await sdk.token.transfer.pending(B.partyId)).length === 0);
  const [pre] = (await acs(token, admin, `${PKG}:CusdtToken:CusdtTransferPreapproval`)).filter((c) => c.createArgument.receiver === B.partyId);
  await run(B, [[{ ExerciseCommand: { templateId: `${PKG}:CusdtToken:CusdtTransferPreapproval`, contractId: pre.contractId,
    choice: "CusdtTransferPreapproval_Cancel", choiceArgument: {} } }], []]);
  ok("external receiver cancels own preapproval", !(await acs(token, admin, `${PKG}:CusdtToken:CusdtTransferPreapproval`)).some((c) => c.createArgument.receiver === B.partyId));
});

await step("merge", async () => {
  const before = (await holdings(A)).length;
  const merged = await sdk.token.utxos.merge({ partyId: A.partyId });
  if (!merged[0]?.length) { ok("merge (nothing to merge)", before <= 1, `${before} holding(s)`); return; }
  await run(A, merged);
  ok("merge by external party consolidates", (await holdings(A)).length === 1, `${before} -> 1`);
});

await step("allocation create + withdraw", async () => {
  const iso = (ms) => new Date(Date.now() + ms).toISOString();
  const spec = { settlement: { executor: admin, settlementRef: { id: `ext-alloc-${Date.now()}`, cid: null }, requestedAt: iso(-30_000), allocateBefore: iso(600_000), settleBefore: iso(1_200_000), meta: { values: {} } },
    transferLegId: "leg-1", transferLeg: { sender: A.partyId, receiver: B.partyId, amount: "3", instrumentId: { admin, id: "YAP" }, meta: { values: {} } } };
  await run(A, await sdk.token.allocation.instruction.create({ allocationSpecification: spec, asset }));
  const pend = await sdk.token.allocation.pending(A.partyId);
  ok("external sender's allocation created and visible", pend.length >= 1 && (await holdings(A)).some((h) => h.interfaceViewValue.lock));
  await run(A, await sdk.token.allocation.withdraw({ allocationCid: pend[0].contractId, asset }));
  ok("withdraw by external sender releases the lock", (await holdings(A)).every((h) => !h.interfaceViewValue.lock) && total(await holdings(A)) === A0 - 3);
});

console.log(`\nend: ext-alice ${total(await holdings(A))}, ext-bob ${total(await holdings(B))} (started ${A0}/${B0})`);
console.log(`${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
