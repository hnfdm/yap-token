// End-to-end CIP-56 flow through the registry API, exactly as a wallet would do it:
//   1. ask the registry for the transfer factory   2. TransferFactory_Transfer as sender
//   3. TransferInstruction_Accept as receiver      4. print balances
// Usage: node scripts/4-e2e-test.mjs <senderParty> <receiverParty> <amount>
// Both parties must be hosted on this participant and the ledger user needs CanActAs on both.
import { getToken, acs, submit, need, PKG } from "./lib.mjs";

const [sender, receiver, amount] = process.argv.slice(2);
if (!sender || !receiver || !(Number(amount) > 0)) throw new Error("usage: 4-e2e-test.mjs <sender> <receiver> <amount>");
const admin = need("CUSDT_ADMIN_PARTY");
const registry = process.env.CUSDT_REGISTRY_URL || "http://localhost:8787";
const token = await getToken();
const HOLDING = `${PKG}:CusdtToken:CusdtHolding`;
const IFACE_TF = "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory";
const IFACE_TI = "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction";

const balance = async (p) => (await acs(token, p, HOLDING)).filter((c) => c.createArgument.owner === p);
const sum = (hs) => hs.reduce((s, h) => s + Number(h.createArgument.amount), 0);

const sHold = await balance(sender);
console.log(`sender holdings: ${sHold.length}, total ${sum(sHold)}`);
if (sum(sHold) < Number(amount)) throw new Error("sender has insufficient cUSDT (mint first)");

const transfer = {
  sender, receiver, amount: Number(amount).toFixed(10),
  instrumentId: { admin, id: "YAP" },
  requestedAt: new Date(Date.now() - 30_000).toISOString(),
  executeBefore: new Date(Date.now() + 3_600_000).toISOString(),
  inputHoldingCids: sHold.map((h) => h.contractId),
  meta: { values: {} },
};

const fr = await fetch(`${registry}/registry/transfer-instruction/v1/transfer-factory`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ choiceArguments: { expectedAdmin: admin, transfer, extraArgs: { context: { values: {} }, meta: { values: {} } } }, excludeDebugFields: true }),
});
if (!fr.ok) throw new Error(`registry ${fr.status}: ${await fr.text()}`);
const factory = await fr.json();
console.log("factory:", factory.factoryId.slice(0, 24) + "...", "kind:", factory.transferKind);

await submit(token, {
  actAs: [sender], readAs: [sender], label: "transfer",
  disclosedContracts: factory.choiceContext.disclosedContracts,
  commands: [{ ExerciseCommand: {
    templateId: IFACE_TF, contractId: factory.factoryId, choice: "TransferFactory_Transfer",
    choiceArgument: { expectedAdmin: admin, transfer, extraArgs: { context: factory.choiceContext.choiceContextData, meta: { values: {} } } },
  } }],
});
console.log("transfer submitted");

if (factory.transferKind === "offer") {
  const pending = await acs(token, receiver, `${PKG}:CusdtToken:CusdtTransferInstruction`);
  const ti = pending.find((c) => c.createArgument.transfer.sender === sender);
  if (!ti) throw new Error("pending CusdtTransferInstruction not visible to receiver");
  const cr = await fetch(`${registry}/registry/transfer-instruction/v1/${ti.contractId}/choice-contexts/accept`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ meta: {} }),
  });
  const ctx = await cr.json();
  await submit(token, {
    actAs: [receiver], readAs: [receiver], label: "accept", disclosedContracts: ctx.disclosedContracts,
    commands: [{ ExerciseCommand: {
      templateId: IFACE_TI, contractId: ti.contractId, choice: "TransferInstruction_Accept",
      choiceArgument: { extraArgs: { context: ctx.choiceContextData, meta: { values: {} } } },
    } }],
  });
  console.log("accepted by receiver");
}

console.log(`after: sender ${sum(await balance(sender))}, receiver ${sum(await balance(receiver))}`);
