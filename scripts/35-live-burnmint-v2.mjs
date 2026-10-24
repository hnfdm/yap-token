// LIVE test of cusdt-token 0.5.0 on the real ledger: BurnMint (burn-mint-v1) and the Token Standard V2 transfer interfaces.
//   node scripts/35-live-burnmint-v2.mjs        (.env.testnet = t1)
// Starts the NEW registry code locally (port 18788, CUSDT_ENABLE_V2=1) against the real ledger to test the V2 routes too.
// Supply must end exactly where it started. Own traffic meter; refuses to start with little headroom.
import { spawn } from "node:child_process";
import { loadEnv } from "./lib.mjs";
import { T, snapshot, supply, checkInvariants } from "./invariants.mjs";
import { node, waitFor, sleep } from "./nodes.mjs";

const E = loadEnv(".env.testnet"); if (E.INSECURE_TLS === "1") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const n = node(E, "t1"), admin = E.CUSDT_ADMIN_PARTY, ALICE = E.CUSDT_ALICE, BOB = E.CUSDT_BOB, sfx = admin.split("::")[1];
const HOLD = "#cusdt-token:CusdtToken:CusdtHolding", PRE = "#cusdt-token:CusdtToken:CusdtTransferPreapproval", BMF = "#cusdt-token:CusdtToken:CusdtBurnMintFactory", ADM = "#cusdt-token:CusdtToken:CusdtAdmin";
const I_BM = "#splice-api-token-burn-mint-v1:Splice.Api.Token.BurnMintV1:BurnMintFactory";
const I_TF2 = "#splice-api-token-transfer-instruction-v2:Splice.Api.Token.TransferInstructionV2:TransferFactory";
const I_TI2 = "#splice-api-token-transfer-instruction-v2:Splice.Api.Token.TransferInstructionV2:TransferInstruction";
const I_TI1 = "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction";
const short = (e) => String(e?.message ?? e).replace(/\s+/g, " ");
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const mu = (c) => Math.round(Number(c.createArgument.amount) * 1e6);
const amt = (m) => (m / 1e6).toFixed(10);
const inst = { admin, id: "YAP" };
const noCtx = { context: { values: {} }, meta: { values: {} } };
const acct = (p) => ({ owner: p, provider: null, id: "" });
let pass = 0, fail = 0, txs = 0;
const ok = (m, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}  ${m}${x ? "  — " + x : ""}`); };
const tx = async (actAs, commands, disclosed = []) => { txs++; return n.tx(actAs, commands, disclosed); };
const refused = async (fn, re) => { try { await fn(); return { refused: false, msg: "ACCEPTED" }; } catch (e) { const m = short(e); return { refused: true, matched: re ? re.test(m) : true, msg: m }; } };
const free = async (p) => (await n.acs(p, HOLD)).filter((c) => c.createArgument.owner === p && c.createArgument.lock == null);
const total = async (p) => (await free(p)).reduce((s, c) => s + mu(c), 0);
const exResult = (r, choice) => r.transaction.events.find((e) => e.ExercisedEvent?.choice === choice)?.ExercisedEvent?.exerciseResult;

// ---- guard: traffic headroom on Lighthouse ----
try {
  const j = await (await fetch(`https://lighthouse.testnet.cantonloop.com/api/validators/${encodeURIComponent("cryptolampung-testnet-1::" + sfx)}`, { headers: E.LIGHTHOUSE_API_KEY ? { Authorization: "Bearer " + E.LIGHTHOUSE_API_KEY } : {}, signal: AbortSignal.timeout(20000) })).json();
  const t = j.traffic_status; if (t) { const head = t.total_limit - t.total_consumed; console.log(`t1 traffic headroom: ${head}`); if (head < 100_000) { console.log("too little headroom, refusing"); process.exit(3); } }
} catch { console.log("(traffic headroom unknown, continuing)"); }

const S0 = await snapshot(await n.token(), admin), expected = supply(S0);
console.log(`start: supply ${expected / 1e6}, alice ${await total(ALICE)} micro, bob ${await total(BOB)} micro`);
const books = async (label) => { const v = checkInvariants(await snapshot(await n.token(), admin), expected); ok(`conservation after ${label}`, v.length === 0, v.join("; ")); };

// ---- local registry with the V2 routes, reading the REAL ledger ----
const RP = 18788;
const reg = spawn(process.execPath, ["registry/src/server.mjs"], { env: { ...process.env, HOST: "127.0.0.1", PORT: String(RP), LEDGER_URL: E.LEDGER_URL, KC_TOKEN_URL: E.KC_TOKEN_URL, KC_CLIENT_ID: E.KC_CLIENT_ID, KC_CLIENT_SECRET: E.KC_CLIENT_SECRET, KC_SCOPE: E.KC_SCOPE ?? "daml_ledger_api", CUSDT_ADMIN_PARTY: admin, CUSDT_ENABLE_V2: "1", NODE_TLS_REJECT_UNAUTHORIZED: "0" }, stdio: ["ignore", "ignore", "inherit"] });
await sleep(1200);
const rpost = (path, body) => fetch(`http://127.0.0.1:${RP}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, j: await r.json().catch(() => null) }));

async function group(name, fn) { console.log(`-- ${name}`); try { await fn(); } catch (e) { fail++; console.log(`FAIL  ${name} threw: ${short(e).slice(0, 400)}`); } }

try {
  // =========================== BurnMint ===========================
  let bf = (await n.acs(admin, BMF))[0];
  await group("BurnMint: factory + reshape + net mint + net burn", async () => {
    if (!bf) { await tx([admin], [{ CreateCommand: { templateId: BMF, createArguments: { admin } } }]); bf = (await waitFor(async () => (await n.acs(admin, BMF))[0])).v; }
    ok("CusdtBurnMintFactory exists on the live ledger", !!bf);
    const [adm] = await n.acs(admin, ADM);
    const before = new Set((await free(ALICE)).map((c) => c.contractId));
    await tx([admin], [{ ExerciseCommand: { templateId: ADM, contractId: adm.contractId, choice: "CusdtAdmin_Mint", choiceArgument: { recipient: ALICE, amount: amt(2) } } }]);
    const minted = (await waitFor(async () => (await free(ALICE)).find((c) => !before.has(c.contractId) && mu(c) === 2))).v;
    ok("minted a 2-micro holding for alice", !!minted);
    const bm = (inputs, outputs, extraActors) => ({ ExerciseCommand: { templateId: I_BM, contractId: bf.contractId, choice: "BurnMintFactory_BurnMint", choiceArgument: { expectedAdmin: admin, instrumentId: inst, inputHoldingCids: inputs, outputs: outputs.map(([o, a]) => ({ owner: o, amount: amt(a), context: { values: {} } })), extraActors, extraArgs: noCtx } } });
    const aliceTotal0 = await total(ALICE);
    const r1 = await tx([admin, ALICE], [bm([minted.contractId], [[ALICE, 1], [ALICE, 1]], [ALICE])]);
    const cids1 = exResult(r1, "BurnMintFactory_BurnMint")?.outputCids ?? [];
    ok("reshape: one 2-micro holding became two 1-micro holdings", cids1.length === 2 && (await total(ALICE)) === aliceTotal0);
    // net mint (admin alone), then net burn of exactly that holding (owner consents as extra actor)
    const r2 = await tx([admin], [bm([], [[BOB, 3]], [])]);
    const cid = exResult(r2, "BurnMintFactory_BurnMint")?.outputCids?.[0];
    ok("net mint: 3 micro appeared for bob without his consent", !!cid);
    const sup1 = supply(await snapshot(await n.token(), admin));
    ok("supply grew by exactly 3 micro (on top of the 2 minted for the reshape test)", sup1 === expected + 5, `${sup1 - expected} micro over the start`);
    await tx([admin, BOB], [bm([cid], [], [BOB])]);
    const sup2 = supply(await snapshot(await n.token(), admin));
    ok("net burn: only the 2 micro minted for the reshape test remain", sup2 === expected + 2, `${sup2 - expected} micro over the start`);
    await tx([admin, ALICE], [bm(cids1, [], [ALICE])]);
    const sup3 = supply(await snapshot(await n.token(), admin));
    ok("burning two inputs at once: supply is back to the start", sup3 === expected, `${sup3 - expected} micro off`);
    // live guards
    const [h] = await free(ALICE);
    let x = await refused(() => tx([admin, ALICE], [bm([h.contractId], [[ALICE, mu(h)]], [])]));
    ok("burning alice's holding without her as extra actor is refused", x.refused && /extra actor/.test(x.msg), x.msg.slice(-110));
    x = await refused(() => tx([admin], [{ ExerciseCommand: { templateId: I_BM, contractId: bf.contractId, choice: "BurnMintFactory_BurnMint", choiceArgument: { expectedAdmin: admin, instrumentId: inst, inputHoldingCids: [], outputs: [{ owner: BOB, amount: amt(1), context: { values: { lock: { tag: "AV_Bool", value: true } } } }], extraActors: [], extraArgs: noCtx } } }]));
    ok("an output with a (registry-specific) context is refused", x.refused && /context/.test(x.msg), x.msg.slice(-110));
    x = await refused(() => tx([admin, ALICE], [{ ExerciseCommand: { templateId: I_BM, contractId: bf.contractId, choice: "BurnMintFactory_BurnMint", choiceArgument: { expectedAdmin: BOB, instrumentId: inst, inputHoldingCids: [h.contractId], outputs: [], extraActors: [ALICE], extraArgs: noCtx } } }]));
    ok("wrong expectedAdmin is refused", x.refused);
    await books("BurnMint");
  });

  // =========================== V2 transfers ===========================
  const v2Offer = async (sender, receiver, micro, inputCid) => {
    const body = { choiceArguments: { transfer: { sender: acct(sender), receiver: acct(receiver), amount: amt(micro), instrumentId: inst, requestedAt: iso(-30000), executeBefore: iso(3_600_000), inputHoldingCids: [inputCid], meta: { values: {} } } } };
    const f = await rpost("/registry/transfer-instruction/v2/transfer-factory", body);
    const t = body.choiceArguments.transfer;
    const r = await tx([sender], [{ ExerciseCommand: { templateId: I_TF2, contractId: f.j.factoryId, choice: "TransferFactory_Transfer", choiceArgument: { transfer: t, actors: [sender], extraArgs: { context: f.j.choiceContext.choiceContextData, meta: { values: {} } } } } }], f.j.choiceContext.disclosedContracts);
    return { f, r };
  };
  const pendingV2 = async (p) => { const off = (await n.ledger("/v2/state/ledger-end")).offset;
    const r = await n.ledger("/v2/state/active-contracts", { method: "POST", json: { activeAtOffset: off, eventFormat: { filtersByParty: { [p]: { cumulative: [{ identifierFilter: { InterfaceFilter: { value: { interfaceId: I_TI2, includeInterfaceView: true, includeCreatedEventBlob: false } } } }] } }, verbose: true } } });
    return (Array.isArray(r) ? r : (r.activeContracts ?? [])).map((it) => it.contractEntry?.JsActiveContract?.createdEvent).filter(Boolean); };
  const act = (p, cid, choice) => tx([p], [{ ExerciseCommand: { templateId: I_TI2, contractId: cid, choice, choiceArgument: { actors: [p], extraArgs: noCtx } } }]);
  const biggest = async (p) => (await free(p)).sort((a, b) => mu(b) - mu(a))[0];

  await group("V2: registry factory, offer, view, accept / reject / withdraw", async () => {
    ok("registry advertises V2 (CUSDT_ENABLE_V2=1)", (await (await fetch(`http://127.0.0.1:${RP}/registry/metadata/v1/info`)).json()).supportedApis["splice-api-token-transfer-instruction-v2"] === 1);
    const hA = await biggest(ALICE), b0 = await total(BOB), a0 = await total(ALICE);
    const { f } = await v2Offer(ALICE, BOB, 5, hA.contractId);
    ok("V2 registry answered `offer` with the live factory", f.status === 200 && f.j.transferKind === "offer", `${f.status} ${f.j?.transferKind}`);
    const p = (await waitFor(async () => (await pendingV2(BOB)).find((c) => c.interfaceViews?.[0]?.viewValue?.transfer?.sender?.owner === ALICE))).v;
    const view = p?.interfaceViews?.[0]?.viewValue;
    ok("bob sees the pending offer through the V2 interface view", !!p && view.transfer.receiver.owner === BOB && Number(view.transfer.amount) === 0.000005, JSON.stringify(view?.availableActions ?? {}).slice(0, 110));
    await act(BOB, p.contractId, "TransferInstruction_Accept");
    await sleep(1500);
    ok("accept through V2: bob +5 micro, alice -5 micro", (await total(BOB)) === b0 + 5 && (await total(ALICE)) === a0 - 5);
    ok("the non-consuming V2 choice archived the instruction itself", (await pendingV2(BOB)).filter((c) => c.contractId === p.contractId).length === 0);
    // reject
    const hA2 = await biggest(ALICE);
    await v2Offer(ALICE, BOB, 4, hA2.contractId);
    const p2 = (await waitFor(async () => (await pendingV2(BOB))[0])).v;
    await act(BOB, p2.contractId, "TransferInstruction_Reject"); await sleep(1500);
    ok("reject through V2 refunds alice", (await total(ALICE)) === a0 - 5 && (await total(BOB)) === b0 + 5);
    // withdraw
    const hA3 = await biggest(ALICE);
    await v2Offer(ALICE, BOB, 3, hA3.contractId);
    const p3 = (await waitFor(async () => (await pendingV2(ALICE))[0])).v;
    await act(ALICE, p3.contractId, "TransferInstruction_Withdraw"); await sleep(1500);
    ok("withdraw through V2 refunds alice", (await total(ALICE)) === a0 - 5);
    // V2 offer accepted through V1
    const hA4 = await biggest(ALICE);
    await v2Offer(ALICE, BOB, 2, hA4.contractId);
    const p4 = (await waitFor(async () => (await n.acs(admin, T.INSTR)).find((i) => i.createArgument.transfer.receiver === BOB))).v;
    await tx([BOB], [{ ExerciseCommand: { templateId: I_TI1, contractId: p4.contractId, choice: "TransferInstruction_Accept", choiceArgument: { extraArgs: noCtx } } }]); await sleep(1500);
    ok("a V2 offer accepted through the V1 interface", (await total(BOB)) === b0 + 7);
    await books("V2 flows");
  });

  await group("V2: wrong actors / theft attempts on the live ledger", async () => {
    const hA = await biggest(ALICE); const a0 = await total(ALICE);
    await v2Offer(ALICE, BOB, 2, hA.contractId);
    const p = (await waitFor(async () => (await pendingV2(BOB))[0])).v;
    let x = await refused(() => act(ALICE, p.contractId, "TransferInstruction_Accept"));
    ok("the sender cannot accept her own offer", x.refused && /receiver must be among/.test(x.msg), x.msg.slice(-100));
    x = await refused(() => act(BOB, p.contractId, "TransferInstruction_Withdraw"));
    ok("the receiver cannot withdraw it", x.refused && /sender must be among/.test(x.msg), x.msg.slice(-100));
    await act(ALICE, p.contractId, "TransferInstruction_Withdraw"); await sleep(1200);
    // direct-path theft: bob has a preapproval and names only himself as the actor, alice's holding disclosed to him
    const [adm] = await n.acs(admin, ADM);
    const hv = (await n.acs(ALICE, HOLD, true)).filter((c) => c.createArgument.owner === ALICE && c.createArgument.lock == null).sort((a, b) => mu(b) - mu(a))[0];
    await tx([admin], [{ ExerciseCommand: { templateId: ADM, contractId: adm.contractId, choice: "CusdtAdmin_CreatePreapproval", choiceArgument: { receiver: BOB } } }]);
    const body = { choiceArguments: { transfer: { sender: acct(ALICE), receiver: acct(BOB), amount: amt(1), instrumentId: inst, requestedAt: iso(-30000), executeBefore: iso(3_600_000), inputHoldingCids: [hv.contractId], meta: { values: {} } } } };
    const f = await rpost("/registry/transfer-instruction/v2/transfer-factory", body);
    ok("registry answers `direct` for bob (he has a preapproval)", f.j?.transferKind === "direct");
    const disclosedHolding = { templateId: hv.templateId, contractId: hv.contractId, createdEventBlob: hv.createdEventBlob, synchronizerId: hv.synchronizerId };
    x = await refused(() => tx([BOB], [{ ExerciseCommand: { templateId: I_TF2, contractId: f.j.factoryId, choice: "TransferFactory_Transfer", choiceArgument: { transfer: body.choiceArguments.transfer, actors: [BOB], extraArgs: { context: f.j.choiceContext.choiceContextData, meta: { values: {} } } } } }], [...f.j.choiceContext.disclosedContracts, disclosedHolding]));
    ok("bob CANNOT spend alice's holding through the direct path (the sender must be among the actors)", x.refused && /sender must be among/.test(x.msg), x.msg.slice(-120));
    ok("alice still owns her money", (await total(ALICE)) === a0);
    // the owner's own direct transfer works, then clean up the preapproval
    await tx([ALICE], [{ ExerciseCommand: { templateId: I_TF2, contractId: f.j.factoryId, choice: "TransferFactory_Transfer", choiceArgument: { transfer: body.choiceArguments.transfer, actors: [ALICE], extraArgs: { context: f.j.choiceContext.choiceContextData, meta: { values: {} } } } } }], f.j.choiceContext.disclosedContracts);
    await sleep(1200);
    ok("alice's own direct V2 transfer credits bob at once (no pending instruction)", (await n.acs(admin, T.INSTR)).filter((i) => i.createArgument.transfer.receiver === BOB).length === 0);
    for (const pre of (await n.acs(BOB, PRE)).filter((q) => q.createArgument.receiver === BOB)) await tx([BOB], [{ ExerciseCommand: { templateId: PRE, contractId: pre.contractId, choice: "CusdtTransferPreapproval_Cancel", choiceArgument: {} } }]);
    ok("bob's preapproval cancelled again", (await n.acs(BOB, PRE)).filter((q) => q.createArgument.receiver === BOB).length === 0);
    await books("V2 theft attempts");
  });
} finally { reg.kill(); }

console.log(`\ntransactions submitted by this test: ${txs}\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
