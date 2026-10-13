// Read-only: parse only recent history (after the 0.3.1 rotation) and show how bob's allocation settlement is labelled.
import { SDK } from "@canton-network/wallet-sdk";
import { getToken, need } from "../scripts/lib.mjs";
const admin = need("CUSDT_ADMIN_PARTY");
const BOB = `cusdt-bob::${admin.split("::")[1]}`;
const REGISTRY = process.env.CUSDT_REGISTRY_URL || "https://registry-testnet.airdropasc.com";
const after = Number(process.argv[2] ?? 463000);
const auth = { method: "static", token: await getToken() };
const sdk = await (await SDK.create({ auth, ledgerClientUrl: need("LEDGER_URL") })).extend({ token: { auth, registries: [REGISTRY], registryAuth: "none" } });
const tx = await sdk.token.holdings({ partyId: BOB, afterOffset: after });
for (const t of tx.transactions ?? []) {
  for (const e of t.events ?? []) {
    const l = e.label ?? {};
    console.log(`offset~${t.offset ?? "?"} ${l.type}${l.tokenStandardChoice ? " [" + (l.tokenStandardChoice.name ?? l.tokenStandardChoice.choice ?? "") + "]" : ""}${l.receiverAmounts ? " -> " + JSON.stringify(l.receiverAmounts) : ""}`);
  }
}
