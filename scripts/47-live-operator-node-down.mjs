// LIVE probe: can the OPERATOR act while one of the two hosting nodes (t2) is down?  (same setup as 46: stop t2, run, start t2 again)
// The operator's authority contract has the admin (cusdt-gov, 2-of-2) as signatory, so the question is whether the admin's confirmation
// threshold still has to be met. The command is YapOperator_CreatePreapproval: nonconsuming, does not touch the supply.
//   node scripts/47-live-operator-node-down.mjs        (.env.testnet = t1)
import { loadEnv } from "./lib.mjs";
import { node, sleep } from "./nodes.mjs";

const E = loadEnv(".env.testnet"); if (E.INSECURE_TLS === "1") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const n = node(E, "t1");
const GOV = E.CUSDT_GOV_PARTY ?? "cusdt-gov::12205fb8f032bfcfe6ae4ae3a7625629fe9065668ee529e3a785691e1cdce5022c2b";
const OP = E.CUSDT_OPERATOR, RECEIVER = E.YAP_POOL_MARKETING;
const P = "#yap-token:YapToken:";
const prea = async () => (await n.acs(GOV, P + "YapTransferPreapproval")).filter((c) => c.createArgument.receiver === RECEIVER).length;
const auth = (await n.acs(GOV, P + "YapOperatorAuthority")).filter((c) => c.createArgument.operator === OP);
if (auth.length !== 1) throw new Error(`expected 1 operator authority, found ${auth.length}`);
const before = await prea();
console.log(`operator authority found (allowance ${auth[0].createArgument.allowance}); preapprovals for the receiver: ${before}`);
const t0 = Date.now();
const body = { commands: { commands: [{ ExerciseCommand: { templateId: P + "YapOperatorAuthority", contractId: auth[0].contractId, choice: "YapOperator_CreatePreapproval", choiceArgument: { receiver: RECEIVER } } }], commandId: `opdown-${Date.now()}`, actAs: [OP], readAs: [OP] },
  transactionFormat: { transactionShape: "TRANSACTION_SHAPE_LEDGER_EFFECTS", eventFormat: { filtersByParty: { [OP]: {} }, verbose: true } } };
const call = n.ledger("/v2/commands/submit-and-wait-for-transaction", { method: "POST", json: body }).then(() => "completed", (e) => "error: " + String(e.message).replace(/\s+/g, " ").slice(0, 200));
const first = await Promise.race([call, sleep(90_000).then(() => "no answer after 90 s")]);
console.log(`after ${Math.round((Date.now() - t0) / 1000)} s: ${first}`);
console.log(first === "completed" ? "RESULT: the operator CAN act with one node down" : "RESULT: the operator CANNOT act with one node down (start t2 again; polling up to 5 minutes)");
if (first !== "completed") for (let i = 0; i < 60; i++) { await sleep(5000); try { if ((await prea()) > before) { console.log(`+${Math.round((Date.now() - t0) / 1000)} s: the command went through after the node came back`); break; } } catch {} }
console.log(`preapprovals for the receiver now: ${await prea().catch(() => "?")} (before ${before})`);
