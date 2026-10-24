// Give a party a direct-transfer preapproval (idempotent).  Usage: node scripts/9-preapprove.mjs <party>
import { getToken, acs, submit, need, PKG } from "./lib.mjs";

const receiver = process.argv[2];
if (!receiver) throw new Error("usage: 9-preapprove.mjs <party>");
const admin = need("CUSDT_ADMIN_PARTY");
const token = await getToken();

const existing = (await acs(token, admin, `${PKG}:YapToken:YapTransferPreapproval`))
  .filter((c) => c.createArgument.receiver === receiver);
if (existing.length) { console.log("already has preapproval", existing[0].contractId.slice(0, 16) + "..."); process.exit(0); }

const [adm] = await acs(token, admin, `${PKG}:YapToken:YapAdmin`);
if (!adm) throw new Error("YapAdmin not found");
await submit(token, { actAs: [admin], label: "preapprove", commands: [{ ExerciseCommand: {
  templateId: `${PKG}:YapToken:YapAdmin`, contractId: adm.contractId,
  choice: "YapAdmin_CreatePreapproval", choiceArgument: { receiver } } }] });
console.log("preapproval created for", receiver);
