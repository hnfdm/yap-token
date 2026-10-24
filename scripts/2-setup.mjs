// One-time setup on testnet: allocate the cusdt-admin party (participant-hosted), give the
// ledger user rights on it, and create the YapAdmin + YapTransferFactory singleton contracts.
// Safe to re-run: skips whatever already exists.
import { getToken, ledger, acs, submit, need, env, PKG } from "./lib.mjs";

const token = await getToken();
const userId = need("LEDGER_USER_ID");
const hint = env.CUSDT_ADMIN_HINT || "cusdt-admin";

let admin = env.CUSDT_ADMIN_PARTY;
if (!admin) {
  const parties = await ledger(token, "/v2/parties");
  admin = (parties.partyDetails ?? []).find((p) => p.party.startsWith(`${hint}::`))?.party;
  if (!admin) {
    const r = await ledger(token, "/v2/parties", { method: "POST", json: { partyIdHint: hint, identityProviderId: "" } });
    admin = r.partyDetails.party;
    console.log("allocated", admin);
  }
}
console.log("CUSDT_ADMIN_PARTY =", admin);

await ledger(token, `/v2/users/${encodeURIComponent(userId)}/rights`, {
  method: "POST",
  json: {
    userId, identityProviderId: "",
    rights: [
      { kind: { CanActAs: { value: { party: admin } } } },
      { kind: { CanReadAs: { value: { party: admin } } } },
    ],
  },
});
console.log("rights granted to", userId);

for (const tpl of ["YapAdmin", "YapTransferFactory"]) {
  const templateId = `${PKG}:YapToken:${tpl}`;
  if ((await acs(token, admin, templateId)).length) { console.log(tpl, "already exists"); continue; }
  await submit(token, {
    actAs: [admin], label: `create-${tpl}`,
    commands: [{ CreateCommand: { templateId, createArguments: { admin } } }],
  });
  console.log("created", tpl);
}
console.log("\nPut CUSDT_ADMIN_PARTY in .env.testnet, then start the registry.");
