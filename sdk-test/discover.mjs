// Read-only: does the official Wallet SDK understand our registry and contracts?
//   1. discover YAP from the registry (metadata-v1)     2. list holdings via the Holding interface view
//   3. list pending transfer instructions via the TransferInstruction interface view
import { SDK } from "@canton-network/wallet-sdk";
import { getToken, env, need } from "../scripts/lib.mjs";

const admin = need("CUSDT_ADMIN_PARTY");
const suffix = admin.split("::")[1];
const ALICE = `cusdt-alice::${suffix}`, BOB = `cusdt-bob::${suffix}`;
const REGISTRY = process.env.CUSDT_REGISTRY_URL || "https://registry-testnet.cryptolampung.space";

const token = await getToken();
const auth = { method: "static", token };

const sdk0 = await SDK.create({ auth, ledgerClientUrl: need("LEDGER_URL") });
const sdk = await sdk0.extend({ token: { auth, registries: [REGISTRY], registryAuth: "none" } });

console.log("registry:", REGISTRY);
const assets = await sdk.token.assets();
console.log("assets:", JSON.stringify(assets, null, 1));
const a = assets.find((x) => x.id === "YAP");
console.log(a && a.admin === admin ? "PASS  YAP discovered with the right admin" : "FAIL  YAP not discovered / admin mismatch");

for (const [name, p] of [["alice", ALICE], ["bob", BOB]]) {
  const h = await sdk.token.utxos.list({ partyId: p, includeLocked: true });
  console.log(`${name} holdings via SDK: ${h.length}`);
  for (const c of h) {
    const v = c.interfaceViewValue;
    console.log("  ", c.contractId.slice(0, 14) + "...", v.instrumentId?.id, v.amount, v.lock ? "LOCKED" : "free");
  }
  const pend = await sdk.token.transfer.pending(p);
  console.log(`${name} pending transfer instructions: ${pend.length}`);
}
