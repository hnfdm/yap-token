// cUSDT between TWO participants of the same testnet: ours (asc-val-1: admin, alice) and MZF's (carol).
//   node scripts/21-cross-participant.mjs        (needs .env.testnet and .env.mzf, run 20-mzf-setup first)
// Tiny amounts only: the MZF validator has ~210k traffic units in total.
import { readFileSync } from "node:fs";
import { loadEnv } from "./lib.mjs";
import { T, snapshot, supply, checkInvariants, retry, retrySend } from "./invariants.mjs";
import { makeOps, amt, IF } from "./ops.mjs";
import { node } from "./nodes.mjs";

const OURS = loadEnv(".env.testnet"), MZF = loadEnv(".env.mzf");
if (OURS.INSECURE_TLS === "1" || MZF.INSECURE_TLS === "1") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const admin = OURS.CUSDT_ADMIN_PARTY, suffix = admin.split("::")[1];
const ALICE = `cusdt-alice::${suffix}`, CAROL = MZF.CUSDT_MZF_CAROL;
const REGISTRY = process.env.CUSDT_REGISTRY_URL || "https://registry-testnet.cryptolampung.space";
const PKG = "#cusdt-token";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (e) => String(e?.message ?? e).replace(/\s+/g, " ");

const ours = node(OURS, "ours"), mzf = node(MZF, "mzf");
const opsNow = async () => makeOps({ token: await ours.token(), admin, registry: REGISTRY });
const sumH = (hs) => hs.reduce((s, h) => s + Math.round(Number(h.createArgument.amount) * 1e6), 0);
const mine = async (nd, p) => (await nd.acs(p, `${PKG}:CusdtToken:CusdtHolding`)).filter((c) => c.createArgument.owner === p && c.createArgument.lock == null);
const waitFor = async (what, fn, ms = 90_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return { v, s: Math.round((Date.now() - t0) / 1000) }; await sleep(3000); } return { v: null, s: Math.round(ms / 1000) }; };

let pass = 0, fail = 0;
const ok = (n, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  — " + x : ""}`); };
async function group(name, fn) { console.log(`-- ${name}`); try { await fn(); } catch (e) { fail++; console.log(`FAIL  ${name} threw: ${short(e).slice(0, 400)}`); } }
const expected = supply(await snapshot(await ours.token(), admin));
async function books(label) { const v = checkInvariants(await snapshot(await ours.token(), admin), expected); ok(`conservation (read as admin on OUR node, covers carol's holdings) after ${label}`, v.length === 0, v.join("; ")); }
const ti = (cid, choice) => [{ ExerciseCommand: { templateId: IF.TI, contractId: cid, choice, choiceArgument: { extraArgs: { context: { values: {} }, meta: { values: {} } } } } }];
const regPost = (path, body) => fetch(`${REGISTRY}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

console.log(`ours : alice ${sumH(await mine(ours, ALICE))} micro | mzf: carol ${sumH(await mine(mzf, CAROL))} micro | supply ${expected / 1e6}\n`);
const cleanupLog = [];

await group("1. offer: alice (our node) -> carol (MZF node), carol accepts there", async () => {
  const c0 = sumH(await mine(mzf, CAROL)); const o = await opsNow();
  const h = (await mine(ours, ALICE)).sort((a, b) => Number(b.createArgument.amount) - Number(a.createArgument.amount))[0];
  await o.transfer(ALICE, CAROL, amt(2), [h])();
  const seen = await waitFor("instruction at carol", async () => (await mzf.acs(CAROL, `${PKG}:CusdtToken:CusdtTransferInstruction`)).find((i) => i.createArgument.transfer.sender === ALICE));
  ok("the offer reaches the OTHER participant", !!seen.v, `visible at carol after ~${seen.s}s`);
  await mzf.tx([CAROL], ti(seen.v.contractId, "TransferInstruction_Accept"));
  const got = await waitFor("holding at carol", async () => sumH(await mine(mzf, CAROL)) === c0 + 2);
  ok("carol accepted on her own node and holds the 2 micro", !!got.v);
  await books("1");
});

await group("2. direct: preapproval for a REMOTE receiver, carol cancels it on her node", async () => {
  const c0 = sumH(await mine(mzf, CAROL)); const o = await opsNow();
  const [adm] = await ours.acs(admin, T.ADMIN);
  await ours.tx([admin], [{ ExerciseCommand: { templateId: T.ADMIN, contractId: adm.contractId, choice: "CusdtAdmin_CreatePreapproval", choiceArgument: { receiver: CAROL } } }]);
  const h = (await mine(ours, ALICE))[0];
  const probe = await regPost("/registry/transfer-instruction/v1/transfer-factory", { choiceArguments: { expectedAdmin: admin, transfer: { sender: ALICE, receiver: CAROL, amount: amt(1), instrumentId: { admin, id: "YAP" }, requestedAt: new Date(Date.now() - 30000).toISOString(), executeBefore: new Date(Date.now() + 3.6e6).toISOString(), inputHoldingCids: [], meta: { values: {} } } } });
  ok("registry answers `direct` for a receiver on another participant", probe.transferKind === "direct", probe.transferKind);
  await o.transfer(ALICE, CAROL, amt(1), [h])();
  const got = await waitFor("direct credit", async () => sumH(await mine(mzf, CAROL)) === c0 + 1);
  ok("direct transfer credited carol with no accept", !!got.v, `after ~${got.s}s`);
  const pre = (await mzf.acs(CAROL, `${PKG}:CusdtToken:CusdtTransferPreapproval`))[0];
  ok("carol can see her preapproval", !!pre);
  if (pre) { await mzf.tx([CAROL], [{ ExerciseCommand: { templateId: `${PKG}:CusdtToken:CusdtTransferPreapproval`, contractId: pre.contractId, choice: "CusdtTransferPreapproval_Cancel", choiceArgument: {} } }]); ok("carol cancelled it from her node", true); }
  await books("2");
});

await group("3. carol is the SENDER: factory + disclosure come from OUR registry, she submits on HER node", async () => {
  const a0 = sumH(await mine(ours, ALICE)); const holdings = await mine(mzf, CAROL);
  const t = { sender: CAROL, receiver: ALICE, amount: amt(1), instrumentId: { admin, id: "YAP" }, requestedAt: new Date(Date.now() - 30000).toISOString(), executeBefore: new Date(Date.now() + 3.6e6).toISOString(), inputHoldingCids: [holdings[0].contractId], meta: { values: {} } };
  const f = await regPost("/registry/transfer-instruction/v1/transfer-factory", { choiceArguments: { expectedAdmin: admin, transfer: t } });
  await mzf.tx([CAROL], [{ ExerciseCommand: { templateId: IF.TF, contractId: f.factoryId, choice: "TransferFactory_Transfer",
    choiceArgument: { expectedAdmin: admin, transfer: t, extraArgs: { context: f.choiceContext.choiceContextData, meta: { values: {} } } } } }], f.choiceContext.disclosedContracts);
  ok("carol sent using a factory she does not host (disclosed by the registry)", true, `kind ${f.transferKind}`);
  const seen = await waitFor("instruction at alice", async () => (await ours.acs(ALICE, T.INSTR)).find((i) => i.createArgument.transfer.sender === CAROL));
  ok("the offer reaches alice on OUR node", !!seen.v, `after ~${seen.s}s`);
  await ours.tx([ALICE], ti(seen.v.contractId, "TransferInstruction_Accept"));
  ok("alice accepted and received it", (await waitFor("alice holding", async () => sumH(await mine(ours, ALICE)) === a0 + 1)).v !== null);
  await books("3");
});

await group("4. allocation across participants (executor admin + receiver alice on OUR node, sender carol on HERS)", async () => {
  const holdings = await mine(mzf, CAROL);
  const spec = { settlement: { executor: admin, settlementRef: { id: `xp-${Date.now()}`, cid: null }, requestedAt: new Date(Date.now() - 30000).toISOString(), allocateBefore: new Date(Date.now() + 3.6e6).toISOString(), settleBefore: new Date(Date.now() + 7.2e6).toISOString(), meta: { values: {} } },
    transferLegId: "leg-1", transferLeg: { sender: CAROL, receiver: ALICE, amount: amt(1), instrumentId: { admin, id: "YAP" }, meta: { values: {} } } };
  const args = { expectedAdmin: admin, allocation: spec, requestedAt: new Date(Date.now() - 30000).toISOString(), inputHoldingCids: [holdings[0].contractId] };
  const f = await regPost("/registry/allocation-instruction/v1/allocation-factory", { choiceArguments: args });
  await mzf.tx([CAROL], [{ ExerciseCommand: { templateId: IF.AF, contractId: f.factoryId, choice: "AllocationFactory_Allocate", choiceArgument: { ...args, extraArgs: { context: f.choiceContext.choiceContextData, meta: { values: {} } } } } }], f.choiceContext.disclosedContracts);
  const alloc = (await waitFor("allocation", async () => (await ours.acs(admin, T.ALLOC)).find((a) => a.createArgument.allocation.settlement.settlementRef.id === spec.settlement.settlementRef.id))).v;
  ok("carol (remote sender) created the allocation; admin sees it on OUR node", !!alloc);
  const exec = [{ ExerciseCommand: { templateId: IF.A, contractId: alloc.contractId, choice: "Allocation_ExecuteTransfer", choiceArgument: { extraArgs: { context: { values: {} }, meta: { values: {} } } } } }];
  let m1 = ""; try { await ours.tx([admin, CAROL, ALICE], exec); } catch (e) { m1 = short(e); }
  ok("execute submitted from OUR node (carol is not hosted here) is refused", m1 !== "", m1.replace(/^ours .*?-> /, "").slice(0, 200) || "UNEXPECTEDLY SUCCEEDED");
  let m2 = ""; try { await mzf.tx([admin, CAROL, ALICE], exec); } catch (e) { m2 = short(e); }
  ok("execute submitted from HER node (admin and alice are not hosted there) is refused", m2 !== "", m2.replace(/^mzf .*?-> /, "").slice(0, 200) || "UNEXPECTEDLY SUCCEEDED");
  await mzf.tx([CAROL], [{ ExerciseCommand: { templateId: IF.A, contractId: alloc.contractId, choice: "Allocation_Withdraw", choiceArgument: { extraArgs: { context: { values: {} }, meta: { values: {} } } } } }]);
  ok("the remote sender can still withdraw (single authority)", (await waitFor("withdrawn", async () => (await ours.acs(admin, T.ALLOC)).length === 0)).v !== null);
  await books("4");
});

await group("5. cleanup: carol returns everything to alice", async () => {
  const hs = await mine(mzf, CAROL); const total = sumH(hs);
  if (total > 0) {
    const t = { sender: CAROL, receiver: ALICE, amount: amt(total), instrumentId: { admin, id: "YAP" }, requestedAt: new Date(Date.now() - 30000).toISOString(), executeBefore: new Date(Date.now() + 3.6e6).toISOString(), inputHoldingCids: hs.map((h) => h.contractId), meta: { values: {} } };
    const f = await regPost("/registry/transfer-instruction/v1/transfer-factory", { choiceArguments: { expectedAdmin: admin, transfer: t } });
    await mzf.tx([CAROL], [{ ExerciseCommand: { templateId: IF.TF, contractId: f.factoryId, choice: "TransferFactory_Transfer", choiceArgument: { expectedAdmin: admin, transfer: t, extraArgs: { context: f.choiceContext.choiceContextData, meta: { values: {} } } } } }], f.choiceContext.disclosedContracts);
    const seen = await waitFor("instruction at alice", async () => (await ours.acs(ALICE, T.INSTR)).find((i) => i.createArgument.transfer.sender === CAROL));
    if (seen.v) await ours.tx([ALICE], ti(seen.v.contractId, "TransferInstruction_Accept"));
  }
  ok("carol holds nothing afterwards", (await waitFor("empty", async () => sumH(await mine(mzf, CAROL)) === 0)).v !== null);
  await books("cleanup");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
