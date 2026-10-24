// Mint YAP.  Usage: node scripts/3-mint.mjs <recipientParty> <amount>
import { getToken, acs, submit, need, PKG } from "./lib.mjs";

const [recipient, amount] = process.argv.slice(2);
if (!recipient || !(Number(amount) > 0)) throw new Error("usage: 3-mint.mjs <recipientParty> <amount>");
const admin = need("CUSDT_ADMIN_PARTY");
const token = await getToken();

const [adminCt] = await acs(token, admin, `${PKG}:YapToken:YapAdmin`);
if (!adminCt) throw new Error("YapAdmin contract not found (run 2-setup first)");

await submit(token, {
  actAs: [admin], label: "mint",
  commands: [{ ExerciseCommand: {
    templateId: `${PKG}:YapToken:YapAdmin`, contractId: adminCt.contractId,
    choice: "YapAdmin_Mint", choiceArgument: { recipient, amount: Number(amount).toFixed(10) },
  } }],
});
console.log(`minted ${amount} YAP -> ${recipient}`);
