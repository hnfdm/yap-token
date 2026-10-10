// Internal (participant-hosted) <-> external (self-custodial) parties.
// Plain transfers between the two kinds work, because every step is signed by ONE kind of party.
import { SDK } from "@canton-network/wallet-sdk";
import { readFileSync } from "node:fs";
import { getToken, ledger, need } from "../scripts/lib.mjs";
import { snapshot, supply, checkInvariants } from "../scripts/invariants.mjs";

const admin = need("CUSDT_ADMIN_PARTY");
const suffix = admin.split("::")[1];
const IA = `cusdt-alice::${suffix}`, IB = `cusdt-bob::${suffix}`;                   // internal
const keys = JSON.parse(readFileSync(new URL("./.keys/ext-parties.json", import.meta.url), "utf8"));
const EA = keys["cusdt-ext-alice"], EB = keys["cusdt-ext-bob"];                      // external
const REGISTRY = process.env.CUSDT_REGISTRY_URL || "https://registry-testnet.mahawallet.xyz";
const token = await getToken();
const auth = { method: "static", token };
const sdk = await (await SDK.create({ auth, ledgerClientUrl: need("LEDGER_URL") })).extend({ token: { auth, registries: [REGISTRY], registryAuth: "none" } });
const asset = (await sdk.token.assets()).find((a) => a.id === "cUSDT");
const short = (e) => String(e?.message ?? e?.response?.data ?? e).replace(/\s+/g, " ");
const iso = (ms) => new Date(Date.now() + ms).toISOString();
let n = 0;

// one submission path per kind of party
const asInternal = async (party, [cmd, disclosed]) => sdk.ledger.internal.submit({ commands: Array.isArray(cmd) ? cmd : [cmd], actAs: [party], readAs: [party], disclosedContracts: disclosed ?? [], commandId: `mix-${Date.now()}-${n++}` });
const asExternal = async (p, [cmd, disclosed]) => sdk.ledger.prepare({ partyId: p.partyId, commands: Array.isArray(cmd) ? cmd : [cmd], disclosedContracts: disclosed ?? [], commandId: `mix-${Date.now()}-${n++}` }).sign(p.privateKey).execute({ partyId: p.partyId });
const as = (who, prepared) => typeof who === "string" ? asInternal(who, prepared) : asExternal(who, prepared);
const id = (who) => typeof who === "string" ? who : who.partyId;
const bal = async (who) => (await sdk.token.utxos.list({ partyId: id(who), includeLocked: true })).reduce((s, h) => s + Math.round(Number(h.interfaceViewValue.amount) * 1e6), 0);

let pass = 0, fail = 0;
const ok = (name, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}  ${name}${x ? "  — " + x : ""}`); };
async function step(name, fn) { try { await fn(); } catch (e) { fail++; console.log(`FAIL  ${name}  — threw: ${short(e).slice(0, 300)}`); } }

/** offer from `from` to `to`, accepted by `to`; each side uses ITS OWN kind of signing */
async function offerAndAccept(label, from, to, micro) {
  const f0 = await bal(from), t0 = await bal(to);
  await as(from, await sdk.token.transfer.create({ sender: id(from), recipient: id(to), amount: (micro / 1e6).toFixed(6), instrumentId: "cUSDT", registryUrl: REGISTRY }));
  const pend = await sdk.token.transfer.pending(id(to));
  const mine = pend.find((p) => p.interfaceViewValue.transfer.sender === id(from));
  if (!mine) throw new Error("pending instruction not visible to the receiver");
  await as(to, await sdk.token.transfer.accept({ transferInstructionCid: mine.contractId, registryUrl: REGISTRY }));
  ok(label, (await bal(from)) === f0 - micro && (await bal(to)) === t0 + micro, `${micro} micro moved`);
}

const S0 = await snapshot(token, admin); const expected = supply(S0);
console.log(`start: internal alice ${await bal(IA)}, internal bob ${await bal(IB)}, ext-alice ${await bal(EA)}, ext-bob ${await bal(EB)} (micro)\n`);

await step("ext -> int", async () => offerAndAccept("EXTERNAL ext-alice -> INTERNAL bob (sender signs locally, receiver accepts with actAs)", EA, IB, 3));
await step("int -> ext", async () => offerAndAccept("INTERNAL alice -> EXTERNAL ext-bob (alice acts, ext-bob accepts with his own signature)", IA, EB, 2));
await step("direct int -> ext", async () => {
  // direct transfer needs a preapproval: issuer creates it, the EXTERNAL receiver can cancel it with its own signature
  const { acs, submit: rawSubmit, PKG } = await import("../scripts/lib.mjs");
  const [adm] = await acs(token, admin, `${PKG}:CusdtToken:CusdtAdmin`);
  await rawSubmit(token, { actAs: [admin], label: "mix-pre", commands: [{ ExerciseCommand: { templateId: `${PKG}:CusdtToken:CusdtAdmin`, contractId: adm.contractId, choice: "CusdtAdmin_CreatePreapproval", choiceArgument: { receiver: EB.partyId } } }] });
  const t0 = await bal(EB), f0 = await bal(IA);
  await as(IA, await sdk.token.transfer.create({ sender: IA, recipient: EB.partyId, amount: "0.000001", instrumentId: "cUSDT", registryUrl: REGISTRY }));
  ok("DIRECT internal -> external (preapproved): credited with no accept", (await bal(EB)) === t0 + 1 && (await bal(IA)) === f0 - 1 && (await sdk.token.transfer.pending(EB.partyId)).length === 0);
  const [pre] = (await acs(token, admin, `${PKG}:CusdtToken:CusdtTransferPreapproval`)).filter((c) => c.createArgument.receiver === EB.partyId);
  await asExternal(EB, [[{ ExerciseCommand: { templateId: `${PKG}:CusdtToken:CusdtTransferPreapproval`, contractId: pre.contractId, choice: "CusdtTransferPreapproval_Cancel", choiceArgument: {} } }], []]);
});
await step("give back", async () => {                       // restore the starting balances
  await offerAndAccept("give back: ext-bob -> internal alice", EB, IA, 3);
  await offerAndAccept("give back: internal bob -> ext-alice", IB, EA, 3);
});

// (The real limit - ONE transaction needing internal AND external authority - is demonstrated in mixed-settlement.mjs.)

const v = checkInvariants(await snapshot(token, admin), expected);
ok("conservation invariants hold", v.length === 0, v.join("; "));
console.log(`\nend: internal alice ${await bal(IA)}, internal bob ${await bal(IB)}, ext-alice ${await bal(EA)}, ext-bob ${await bal(EB)} (micro)`);
console.log(`${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
