// Upload the built cUSDT DAR to the participant.  Usage: node scripts/1-upload-dar.mjs [path.dar]
import { readFileSync } from "node:fs";
import { getToken, ledger } from "./lib.mjs";

const dar = process.argv[2] ?? "daml/cusdt-token/.daml/dist/cusdt-token-0.4.1.dar";
const token = await getToken();
await ledger(token, "/v2/packages", { method: "POST", raw: readFileSync(dar), ct: "application/octet-stream" });
console.log(`uploaded ${dar}`);
