// Appoints cusdt-operator on the governed YAP instance with a tiny allowance (1000 micro) that EXPIRES BY ITSELF after 2 hours (no revoke
// round needed). Used to prepare scripts/47 (operator while one node is down). One governed round: confirm on t1 + t2, execute on t1.
//   node scripts/48-appoint-operator-short.mjs        (.env.testnet = t1)
import { loadEnv } from "./lib.mjs";
import { node, waitFor } from "./nodes.mjs";

const E = loadEnv(".env.testnet"); if (E.INSECURE_TLS === "1") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const n = node(E, "t1");
const GOV = E.CUSDT_GOV_PARTY ?? "cusdt-gov::12205fb8f032bfcfe6ae4ae3a7625629fe9065668ee529e3a785691e1cdce5022c2b";
const MEMBER = E.CUSDT_GOV_MEMBER ?? "cryptolampung-testnet-1::122013397e0d9bb71891e884ccd6948a93057115a2fd46a5cf2e4db254844bbd0ea1";
const OP = E.CUSDT_OPERATOR;
const P = "#yap-token:YapToken:", G = "#yap-governance:YapGovernance:";
const auth = async () => (await n.acs(GOV, P + "YapOperatorAuthority")).filter((a) => a.createArgument.operator === OP);
if ((await auth()).length) { console.log("an operator authority already exists: nothing to do"); process.exit(0); }
const [adm] = await n.acs(GOV, P + "YapAdmin");
const validUntil = new Date(Date.now() + 2 * 3600_000).toISOString();
await n.tx([MEMBER], [{ CreateCommand: { templateId: G + "AppointOperatorProposal", createArguments: { governanceParty: GOV, proposer: MEMBER, adminCid: adm.contractId, operator: OP, allowance: "0.001", validUntil } } }]);
console.log(`AppointOperatorProposal created (allowance 0.001 YAP = 1000 micro, expires ${validUntil}).\n\nHUMAN STEP (within 30 minutes):\n  t1:  bash decman-vote-on-vps.sh confirm YapAppointOperator\n  t2:  bash decman-vote-on-vps.sh confirm YapAppointOperator\n  t1:  bash decman-vote-on-vps.sh execute YapAppointOperator\nwaiting up to 20 minutes ...`);
const w = await waitFor(async () => (await auth())[0] ?? null, 20 * 60_000);
console.log(w.v ? `operator authority appeared after ${w.s} s` : "timed out: no authority appeared");
