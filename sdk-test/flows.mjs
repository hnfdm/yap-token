// Full flows driven by the official Canton Wallet SDK (the commands are BUILT by the SDK from our
// registry's answers; we only submit them). Internal parties => submit via ledger.internal.submit.
import { SDK } from "@canton-network/wallet-sdk";
import { getToken, need, acs, submit as rawSubmit, PKG } from "../scripts/lib.mjs";

const admin = need("CUSDT_ADMIN_PARTY");
const suffix = admin.split("::")[1];
const ALICE = `cusdt-alice::${suffix}`, BOB = `cusdt-bob::${suffix}`;
const REGISTRY = process.env.CUSDT_REGISTRY_URL || "https://registry-testnet.cryptolampung.space";

const token = await getToken();
const auth = { method: "static", token };
const sdk = await (await SDK.create({ auth, ledgerClientUrl: need("LEDGER_URL") }))
  .extend({ token: { auth, registries: [REGISTRY], registryAuth: "none" } });
const asset = (await sdk.token.assets()).find((a) => a.id === "cUSDT");

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

const xfer = (sender, recipient, amount) => sdk.token.transfer.create({ sender, recipient, amount: String(amount), instrumentId: "cUSDT", registryUrl: REGISTRY });

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

// 4. SDK's own UTXO merge (it builds a self-transfer)
await step("merge utxos", async () => {
  const before = (await holdings(ALICE)).length;
  const merged = await sdk.token.utxos.merge({ partyId: ALICE });
  if (!merged[0]?.length) { ok("merge (nothing to merge)", before <= 1, `${before} holding(s)`); return; }
  await submit([ALICE], merged);
  const after = await holdings(ALICE);
  ok("SDK merge consolidates alice's holdings", after.length === 1 && total(after) === A0 - 2, `${before} -> ${after.length}`);
});

// 5. direct transfer to a preapproved receiver (preapproval is created by the issuer, then cancelled)
await step("direct transfer", async () => {
  const [adm] = await acs(token, admin, `${PKG}:CusdtToken:CusdtAdmin`);
  await rawSubmit(token, { actAs: [admin], label: "pre", commands: [{ ExerciseCommand: { templateId: `${PKG}:CusdtToken:CusdtAdmin`,
    contractId: adm.contractId, choice: "CusdtAdmin_CreatePreapproval", choiceArgument: { receiver: BOB } } }] });
  await submit([ALICE], await xfer(ALICE, BOB, 1));
  ok("direct: credited with no pending instruction", total(await holdings(BOB)) === B0 + 3 && (await sdk.token.transfer.pending(BOB)).length === 0);
  const [pre] = (await acs(token, admin, `${PKG}:CusdtToken:CusdtTransferPreapproval`)).filter((c) => c.createArgument.receiver === BOB);
  await rawSubmit(token, { actAs: [BOB], label: "cancel", commands: [{ ExerciseCommand: { templateId: `${PKG}:CusdtToken:CusdtTransferPreapproval`,
    contractId: pre.contractId, choice: "CusdtTransferPreapproval_Cancel", choiceArgument: {} } }] });
});

// 6. allocation: create via SDK, see it via the Allocation view, withdraw, then create again and execute
await step("allocation", async () => {
  const iso = (ms) => new Date(Date.now() + ms).toISOString();
  const mkSpec = (ref, amount) => ({
    settlement: { executor: admin, settlementRef: { id: ref, cid: null }, requestedAt: iso(-30_000), allocateBefore: iso(600_000), settleBefore: iso(1_200_000), meta: { values: {} } },
    transferLegId: "leg-1",
    transferLeg: { sender: ALICE, receiver: BOB, amount: String(amount), instrumentId: { admin, id: "cUSDT" }, meta: { values: {} } },
  });
  const create = async (ref, amount) => {
    const r = await sdk.token.allocation.instruction.create({ allocationSpecification: mkSpec(ref, amount), asset });
    await submit([ALICE], r);
  };
  await create(`sdk-alloc-1-${Date.now()}`, 3);
  let pend = await sdk.token.allocation.pending(ALICE);
  ok("allocation visible via SDK Allocation view", pend.length >= 1, `${pend.length} allocation(s)`);
  const locked = (await holdings(ALICE)).filter((h) => h.interfaceViewValue.lock);
  ok("3 cUSDT shown as locked", locked.length === 1 && Number(locked[0].interfaceViewValue.amount) === 3);
  await submit([ALICE], await sdk.token.allocation.withdraw({ allocationCid: pend[0].contractId, asset }));
  ok("withdraw via SDK releases the lock", (await holdings(ALICE)).every((h) => !h.interfaceViewValue.lock) && total(await holdings(ALICE)) === A0 - 3);

  await create(`sdk-alloc-2-${Date.now()}`, 3);
  pend = await sdk.token.allocation.pending(ALICE);
  const ex = await sdk.token.allocation.execute({ allocationCid: pend[0].contractId, asset });
  const cmd = ex.find((x) => x.ExerciseCommand); const disclosed = ex.find(Array.isArray) ?? [];
  await submit([admin, ALICE, BOB], [[cmd], disclosed]);
  ok("execute via SDK pays bob 3", total(await holdings(BOB)) === B0 + 3 + 3);
});

console.log(`\nend: alice ${total(await holdings(ALICE))}, bob ${total(await holdings(BOB))} (started ${A0}/${B0})`);
console.log(`${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
