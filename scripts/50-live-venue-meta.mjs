// LIVE test: a wallet/venue marker in the transfer metadata (like CBTC's `maha/venue = maha`) must survive on the governed YAP instance.
// The contract does not look at `meta`; this proves the registry flow + both transfer versions carry it, on the pending instruction
// (what explorers show as transfer.meta) and in the exercised choice of the submitted transaction.
//   node scripts/50-live-venue-meta.mjs        (.env.testnet = t1; uses the PUBLIC registry; two 1-micro transfers alice -> bob; ~30 s)
import { loadEnv } from "./lib.mjs";
import { node, waitFor, sleep } from "./nodes.mjs";

const E = loadEnv(".env.testnet"); if (E.INSECURE_TLS === "1") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const n = node(E, "t1");
const GOV = E.CUSDT_GOV_PARTY ?? "cusdt-gov::12205fb8f032bfcfe6ae4ae3a7625629fe9065668ee529e3a785691e1cdce5022c2b";
const REG = E.CUSDT_REGISTRY_URL ?? "https://yap-registry-testnet.yapperagent.xyz";
const ALICE = E.CUSDT_ALICE, BOB = E.CUSDT_BOB;
const P = "#yap-token:YapToken:", HOLD = P + "YapHolding", TI = P + "YapTransferInstruction";
const I_TF1 = "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory";
const I_TI1 = "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction";
const I_TF2 = "#splice-api-token-transfer-instruction-v2:Splice.Api.Token.TransferInstructionV2:TransferFactory";
const I_TI2 = "#splice-api-token-transfer-instruction-v2:Splice.Api.Token.TransferInstructionV2:TransferInstruction";
const inst = { admin: GOV, id: "YAP" }, noCtx = { context: { values: {} }, meta: { values: {} } };
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const acct = (p) => ({ owner: p, provider: null, id: "" });
const mu = (c) => Math.round(Number(c.createArgument.amount) * 1e6);
const ex = (templateId, contractId, choice, choiceArgument = {}) => ({ ExerciseCommand: { templateId, contractId, choice, choiceArgument } });
let pass = 0, fail = 0;
const ok = (m, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}  ${m}${x ? "  — " + x : ""}`); };
const total = async (p) => (await n.acs(GOV, HOLD)).filter((c) => c.createArgument.owner === p && c.createArgument.lock == null).reduce((s, c) => s + mu(c), 0);
const post = async (path, json) => { const r = await fetch(REG + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(json) }); return { status: r.status, j: await r.json().catch(() => ({})) }; };
const exercisedMeta = (r, choice) => (r?.transaction?.events ?? []).map((e) => e.ExercisedEvent).find((e) => e?.choice === choice)?.choiceArgument?.transfer?.meta?.values;
const META = { "maha/venue": "maha", "yap/venue": "test-venue", "splice.lfdecentralizedtrust.org/reason": "venue meta test" };
const same = (a) => a && Object.keys(META).every((k) => a[k] === META[k]) && Object.keys(a).length === Object.keys(META).length;

const startA = await total(ALICE), startB = await total(BOB);
for (const v of [1, 2]) {
  console.log(`-- V${v} offer with a venue marker`);
  const hs = (await n.acs(GOV, HOLD)).filter((c) => c.createArgument.owner === ALICE && c.createArgument.lock == null).sort((a, b) => mu(b) - mu(a));
  const t = v === 1
    ? { sender: ALICE, receiver: BOB, amount: "0.0000010000", instrumentId: inst, requestedAt: iso(-30000), executeBefore: iso(3_600_000), inputHoldingCids: [hs[0].contractId], meta: { values: META } }
    : { sender: acct(ALICE), receiver: acct(BOB), amount: "0.0000010000", instrumentId: inst, requestedAt: iso(-30000), executeBefore: iso(3_600_000), inputHoldingCids: [hs[0].contractId], meta: { values: META } };
  const f = await post(`/registry/transfer-instruction/v${v}/transfer-factory`, { choiceArguments: v === 1 ? { expectedAdmin: GOV, transfer: t } : { transfer: t } });
  ok(`registry V${v} accepts a request carrying meta and answers`, f.status === 200 && ["offer", "direct"].includes(f.j.transferKind), `${f.status} ${f.j?.transferKind}`);
  const known = new Set((await n.acs(GOV, TI)).map((c) => c.contractId));
  const args = v === 1 ? { expectedAdmin: GOV, transfer: t, extraArgs: { context: f.j.choiceContext.choiceContextData, meta: { values: {} } } } : { transfer: t, actors: [ALICE], extraArgs: { context: f.j.choiceContext.choiceContextData, meta: { values: {} } } };
  const r = await n.tx([ALICE], [ex(v === 1 ? I_TF1 : I_TF2, f.j.factoryId, "TransferFactory_Transfer", args)], f.j.choiceContext.disclosedContracts);
  ok(`the submitted V${v} transaction carries the marker in the exercised choice`, same(exercisedMeta(r, "TransferFactory_Transfer")), JSON.stringify(exercisedMeta(r, "TransferFactory_Transfer") ?? null).slice(0, 110));
  if (f.j.transferKind === "offer") {
    const p = (await waitFor(async () => (await n.acs(GOV, TI)).find((i) => !known.has(i.contractId) && i.createArgument.transfer.sender === ALICE))).v;
    ok(`the pending V${v} instruction keeps the marker (this is what explorers show)`, same(p?.createArgument?.transfer?.meta?.values), JSON.stringify(p?.createArgument?.transfer?.meta?.values ?? null).slice(0, 110));
    await n.tx([BOB], [ex(v === 1 ? I_TI1 : I_TI2, p.contractId, "TransferInstruction_Accept", v === 1 ? { extraArgs: noCtx } : { actors: [BOB], extraArgs: noCtx })]);
  }
  await sleep(1500);
}
ok("alice paid and bob received exactly 2 micro in total", (await total(ALICE)) === startA - 2 && (await total(BOB)) === startB + 2, `alice ${(await total(ALICE)) - startA}, bob ${(await total(BOB)) - startB}`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
