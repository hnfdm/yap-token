// Read-only: can the SDK's standard transaction parser render our history (what a wallet UI shows)?
import { SDK } from "@canton-network/wallet-sdk";
import { getToken, need } from "../scripts/lib.mjs";

const admin = need("CUSDT_ADMIN_PARTY");
const BOB = `cusdt-bob::${admin.split("::")[1]}`;
const REGISTRY = process.env.CUSDT_REGISTRY_URL || "https://registry-testnet.airdropasc.com";
const token = await getToken();
const auth = { method: "static", token };
const sdk = await (await SDK.create({ auth, ledgerClientUrl: need("LEDGER_URL") }))
  .extend({ token: { auth, registries: [REGISTRY], registryAuth: "none" } });

const end = await sdk.ledger.ledgerEnd();
const tx = await sdk.token.holdings({ partyId: BOB, afterOffset: Math.max(0, end - 400) });
const list = tx.transactions ?? [];
console.log(`parsed ${list.length} transactions for bob (last ~400 offsets)`);
const kinds = {};
for (const t of list) for (const e of t.events ?? []) {
  const k = `${e.label?.type ?? "?"}${e.label?.burnAmount || e.label?.mintAmount ? "" : ""}`;
  kinds[k] = (kinds[k] || 0) + 1;
}
console.log("event label types:", JSON.stringify(kinds));
const sample = list.slice(-3).map((t) => ({ id: t.updateId?.slice(0, 10), events: (t.events ?? []).map((e) => ({ type: e.label?.type, amt: e.label?.mintAmount ?? e.label?.burnAmount ?? e.label?.amount ?? null })) }));
console.log(JSON.stringify(sample, null, 1));
