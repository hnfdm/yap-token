// YAP wallet flows with the official Canton Wallet SDK against the PUBLIC registry of the DECENTRALIZED admin (cusdt-gov).
// Only what a plain wallet does (offer/accept/reject/withdraw/merge). Steps that need the issuer to submit (preapproval, allocation
// execution) are not here: the issuer is a 2-of-2 party and cannot be driven from one PC, by design.
//   CUSDT_ADMIN_PARTY=cusdt-gov::... CUSDT_REGISTRY_URL=https://yap-registry-testnet.yapperagent.xyz node yap-flows.mjs
// (the commands are BUILT by the SDK from our
// registry's answers; we only submit them). Internal parties => submit via ledger.internal.submit.
import { SDK } from "@canton-network/wallet-sdk";
import { getToken, need, acs, submit as rawSubmit, PKG } from "../scripts/lib.mjs";

const admin = need("CUSDT_ADMIN_PARTY");
const suffix = admin.split("::")[1];
const ALICE = need("CUSDT_ALICE"), BOB = need("CUSDT_BOB");
const REGISTRY = process.env.CUSDT_REGISTRY_URL || "https://registry-testnet.cryptolampung.space";

const token = await getToken();
const auth = { method: "static", token };
const sdk = await (await SDK.create({ auth, ledgerClientUrl: need("LEDGER_URL") }))
  .extend({ token: { auth, registries: [REGISTRY], registryAuth: "none" } });
const asset = (await sdk.token.assets()).find((a) => a.id === "YAP");

let n = 0;
const submit = async (parties, [cmds, disclosed]) =>
  sdk.ledger.internal.submit({ commands: Array.isArray(cmds) ? cmds : [cmds], actAs: parties, readAs: parties, disclosedContracts: disclosed ?? [], commandId: `sdk-flow-${Date.now()}-${n++}` });
const holdings = async (p) => (await sdk.token.utxos.list({ partyId: p, includeLocked: true }));
const total = (hs) => hs.reduce((s, h) => s + Number(h.interfaceViewValue.amount), 0);
const free = (hs) => hs.filter((h) => !h.interfaceViewValue.lock);

let pass = 0, fail = 0;
const ok = (name, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}  ${name}${x ? "  — " + x : ""}`); };
async function step(name, fn) { try { await fn(); } catch (e) { fail++; console.log(`FAIL  ${name}  — threw: ${String(e.message).replace(/\s+/g, " ").slice(0, 300)}`); } }

const A0 = total(await holdings(ALICE)), B0 = total(await holdings(BOB));
console.log(`start: alice ${A0}, bob ${B0}\n`);

const xfer = (sender, recipient, amount) => sdk.token.transfer.create({ sender, recipient, amount: String(amount), instrumentId: "YAP", registryUrl: REGISTRY });

// 1. offer -> pending visible through the TransferInstruction view -> accept
await step("offer + accept", async () => {
  await submit([ALICE], await xfer(ALICE, BOB, 2));
  const pend = await sdk.token.transfer.pending(BOB);
  const v = pend[0]?.interfaceViewValue;
  ok("pending instruction visible to bob via SDK", pend.length === 1 && v?.transfer?.sender === ALICE && Number(v.transfer.amount) === 2, v ? `${v.transfer.amount} from alice` : "none");
  await submit([BOB], await sdk.token.transfer.accept({ transferInstructionCid: pend[0].contractId, registryUrl: REGISTRY }));
  ok("accept moves 2 (alice -2, bob +2)", total(await holdings(ALICE)) === A0 - 2 && total(await holdings(BOB)) === B0 + 2);
});

// 2. reject
await step("reject", async () => {
  await submit([ALICE], await xfer(ALICE, BOB, 1));
  const pend = await sdk.token.transfer.pending(BOB);
  await submit([BOB], await sdk.token.transfer.reject({ transferInstructionCid: pend[0].contractId, registryUrl: REGISTRY }));
  ok("reject returns funds, nothing pending", total(await holdings(ALICE)) === A0 - 2 && (await sdk.token.transfer.pending(BOB)).length === 0);
});

// 3. withdraw
await step("withdraw", async () => {
  await submit([ALICE], await xfer(ALICE, BOB, 1));
  const pend = await sdk.token.transfer.pending(BOB);
  await submit([ALICE], await sdk.token.transfer.withdraw({ transferInstructionCid: pend[0].contractId, registryUrl: REGISTRY }));
  ok("withdraw returns funds, nothing pending", total(await holdings(ALICE)) === A0 - 2 && (await sdk.token.transfer.pending(BOB)).length === 0);
});

// 4. SDK's own UTXO merge on a pool party that holds ONLY YAP (alice/bob still carry old cUSDT holdings, which this registry rightly does not know)
await step("merge utxos", async () => {
  const POOL = need("YAP_POOL_AIRDROP");
  const before = free(await holdings(POOL)).length, sum0 = total(await holdings(POOL));
  const merged = await sdk.token.utxos.merge({ partyId: POOL });
  if (!merged[0]?.length) { ok("merge (nothing to merge)", before <= 1, `${before} free holding(s)`); return; }
  await submit([POOL], merged);
  const after = await holdings(POOL);
  ok("SDK merge consolidates the pool's free holdings into one (locked vesting stays)", free(after).length === 1 && total(after) === sum0, `${before} free -> ${free(after).length} free`);
});

console.log(`\nend: alice ${total(await holdings(ALICE))}, bob ${total(await holdings(BOB))} (started ${A0}/${B0})`);
console.log(`${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;

