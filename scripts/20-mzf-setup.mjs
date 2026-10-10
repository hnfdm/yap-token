// One-time setup on a SECOND participant (the MZF testnet validator): create a receiver party, make sure the cUSDT
// package is uploaded/vetted there.   CUSDT_ENV_FILE=.env.mzf node scripts/20-mzf-setup.mjs
// Idempotent. Small on purpose: that validator has only ~210k traffic units.
import { readFileSync, appendFileSync } from "node:fs";
import { getToken, ledger, acs, need, env, PKG } from "./lib.mjs";

const HINT = "cusdt-mzf-carol";
const DAR = process.env.DAR ?? "daml/cusdt-token/.daml/dist/cusdt-token-0.4.1.dar";
const token = await getToken();
console.log("participant:", (await ledger(token, "/v2/version")).version);

// 1. receiver party (participant-hosted) + rights for the ledger user
let party = env.CUSDT_MZF_CAROL;
if (!party) {
  party = (await ledger(token, "/v2/parties", { method: "POST", json: { partyIdHint: HINT, identityProviderId: "" } })).partyDetails.party;
  console.log("allocated", party);
  appendFileSync(new URL("../.env.mzf", import.meta.url), `CUSDT_MZF_CAROL=${party}\n`);
}
const userId = need("LEDGER_USER_ID");
await ledger(token, `/v2/users/${encodeURIComponent(userId)}/rights`, { method: "POST", json: { userId, identityProviderId: "",
  rights: [{ kind: { CanActAs: { value: { party } } } }, { kind: { CanReadAs: { value: { party } } } }] } });
console.log("rights granted; receiver party:", party);

// 2. is the cUSDT package resolvable on THIS participant? (reading with a package-name filter fails with PACKAGE_NAMES_NOT_FOUND if not)
const readable = async () => { try { return (await acs(token, party, `${PKG}:CusdtToken:CusdtHolding`)).length; } catch (e) { if (/PACKAGE_NAMES_NOT_FOUND/.test(String(e.message))) return null; throw e; } };
if ((await readable()) === null) {
  console.log("cusdt-token is NOT on this participant yet: uploading", DAR);
  await ledger(token, "/v2/packages", { method: "POST", raw: readFileSync(DAR), ct: "application/octet-stream" });
}
const n = await readable();
console.log(n === null ? "STILL not resolvable after the upload" : `package resolvable; ACS read as the new party works (${n} holdings)`);
process.exitCode = n === null ? 1 : 0;
