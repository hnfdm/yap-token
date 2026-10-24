// A FOREIGN validator as a third-party integrator would use us: dave lives on the cryptolampung validator and talks ONLY to
//   (a) his own validator's ledger API   and   (b) our public registry (https://registry-testnet.cryptolampung.space, real certificate),
// driven by the official Wallet SDK. Alice (our node) plays the counterpart through a second SDK instance.
//   CUSDT_ENV_FILE=.env.cl node sdk-test/foreign-wallet.mjs        (run from the repo root; ~5 transactions on cryptolampung)
import { SDK } from "@canton-network/wallet-sdk";
import { loadEnv } from "../scripts/lib.mjs";
import { node, waitFor } from "../scripts/nodes.mjs";

const CL = loadEnv(".env.cl"), OURS = loadEnv(".env.testnet");
if (CL.INSECURE_TLS === "1" || OURS.INSECURE_TLS === "1") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";   // the LEDGER hosts are self-signed; the registry is not
const REGISTRY = process.env.CUSDT_REGISTRY_URL || "https://registry-testnet.cryptolampung.space";
const admin = OURS.CUSDT_ADMIN_PARTY, ALICE = `cusdt-alice::${admin.split("::")[1]}`, DAVE = CL.CUSDT_CL_DAVE;

let pass = 0, fail = 0, n = 0;
const ok = (m, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}  ${m}${x ? "  — " + x : ""}`); };
const short = (e) => String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 300);

const dave = await (await SDK.create({ auth: { method: "static", token: await node(CL, "cl").token() }, ledgerClientUrl: CL.LEDGER_URL })).extend({ token: { auth: { method: "static", token: await node(CL, "cl").token() }, registries: [REGISTRY], registryAuth: "none" } });
const alice = await (await SDK.create({ auth: { method: "static", token: await node(OURS, "ours").token() }, ledgerClientUrl: OURS.LEDGER_URL })).extend({ token: { auth: { method: "static", token: await node(OURS, "ours").token() }, registries: [REGISTRY], registryAuth: "none" } });
const submit = (sdk, party) => async ([cmds, disclosed]) => sdk.ledger.internal.submit({ commands: Array.isArray(cmds) ? cmds : [cmds], actAs: [party], readAs: [party], disclosedContracts: disclosed ?? [], commandId: `foreign-${Date.now()}-${n++}` });
const holdings = async (sdk, p) => sdk.token.utxos.list({ partyId: p, includeLocked: true });
const total = (hs) => hs.reduce((s, h) => s + Math.round(Number(h.interfaceViewValue.amount) * 1e6), 0);
const xfer = (sdk, sender, recipient, micro) => sdk.token.transfer.create({ sender, recipient, amount: (micro / 1e6).toFixed(6), instrumentId: "YAP", registryUrl: REGISTRY });
const pendingFor = async (sdk, p, from) => (await sdk.token.transfer.pending(p)).filter((x) => x.interfaceViewValue?.transfer?.sender === from);
async function step(name, fn) { console.log(`-- ${name}`); try { await fn(); } catch (e) { fail++; console.log(`FAIL  ${name} threw: ${short(e)}`); } }

// 0. does the foreign validator's wallet discover the token from the public registry?
await step("discovery from the public registry, over a trusted certificate", async () => {
  const r = await fetch(`${REGISTRY}/registry/metadata/v1/instruments`);   // plain fetch: Node validates the certificate
  ok("registry reachable by a plain fetch (certificate accepted)", r.ok);
  const assets = await dave.token.assets?.();
  const a = assets?.find((x) => x.id === "YAP");
  ok("SDK on the foreign node discovers cUSDT with the right admin", !!a && a.admin === admin, a ? `admin ${a.admin.slice(0, 20)}…` : "not found");
});

const D0 = total(await holdings(dave, DAVE)), A0 = total(await holdings(alice, ALICE));
console.log(`start: dave ${D0} micro (cryptolampung) | alice ${A0} micro (asc-val-1)`);
ok("dave sees his holdings through the SDK on his own node", D0 > 0, `${D0} micro`);

await step("dave -> alice offer (built by the SDK on the foreign node), alice accepts", async () => {
  await submit(dave, DAVE)(await xfer(dave, DAVE, ALICE, 1));
  const seen = await waitFor(async () => (await pendingFor(alice, ALICE, DAVE))[0]);
  ok("the offer reaches alice's node and shows in her SDK's pending list", !!seen.v, `after ~${seen.s}s`);
  if (!seen.v) return;
  await submit(alice, ALICE)(await alice.token.transfer.accept({ transferInstructionCid: seen.v.contractId, registryUrl: REGISTRY }));
  ok("alice accepted: dave -1", (await waitFor(async () => total(await holdings(dave, DAVE)) === D0 - 1)).v !== null);
});

await step("alice -> dave offer, dave accepts through HIS SDK", async () => {
  await submit(alice, ALICE)(await xfer(alice, ALICE, DAVE, 2));
  const seen = await waitFor(async () => (await pendingFor(dave, DAVE, ALICE))[0]);
  ok("the offer shows in the foreign SDK's pending list", !!seen.v, `after ~${seen.s}s`);
  if (!seen.v) return;
  await submit(dave, DAVE)(await dave.token.transfer.accept({ transferInstructionCid: seen.v.contractId, registryUrl: REGISTRY }));
  ok("dave accepted: net +1 micro vs. start", (await waitFor(async () => total(await holdings(dave, DAVE)) === D0 + 1)).v !== null);
});

await step("dave rejects an offer and withdraws his own", async () => {
  await submit(alice, ALICE)(await xfer(alice, ALICE, DAVE, 1));
  const seen = await waitFor(async () => (await pendingFor(dave, DAVE, ALICE))[0]);
  if (!seen.v) return ok("offer to reject arrived", false);
  await submit(dave, DAVE)(await dave.token.transfer.reject({ transferInstructionCid: seen.v.contractId, registryUrl: REGISTRY }));
  ok("reject by dave refunds alice (nothing pending, alice back to A0-1)", (await waitFor(async () => (await pendingFor(dave, DAVE, ALICE)).length === 0 && total(await holdings(alice, ALICE)) === A0 - 1)).v !== null);
  await submit(dave, DAVE)(await xfer(dave, DAVE, ALICE, 1));
  const mine = await waitFor(async () => (await pendingFor(alice, ALICE, DAVE))[0]);
  if (!mine.v) return ok("dave's own offer visible", false);
  await submit(dave, DAVE)(await dave.token.transfer.withdraw({ transferInstructionCid: mine.v.contractId, registryUrl: REGISTRY }));
  ok("withdraw by dave from his own node works", (await waitFor(async () => (await pendingFor(alice, ALICE, DAVE)).length === 0)).v !== null);
});

const D1 = total(await holdings(dave, DAVE)), A1 = total(await holdings(alice, ALICE));
console.log(`end: dave ${D1} micro (was ${D0}) | alice ${A1} micro (was ${A0})`);
ok("conservation across the two nodes (dave+alice unchanged in total)", D1 + A1 === D0 + A0, `${D1 + A1} vs ${D0 + A0}`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
