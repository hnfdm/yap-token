// Can ONE interactive submission mix internal (participant-hosted) and external parties?
// Settlement of an allocation needs executor + sender + receiver. Here executor = admin (internal), receiver = cusdt-bob
// (internal), sender = cusdt-ext-alice (external). Only the external party can sign; the participant authorises the internal ones.
import { SDK } from "@canton-network/wallet-sdk";
import { signTransactionHash } from "@canton-network/core-signing-lib";
import { readFileSync } from "node:fs";
import { getToken, ledger, need } from "../scripts/lib.mjs";
import { snapshot, supply, checkInvariants } from "../scripts/invariants.mjs";

const admin = need("CUSDT_ADMIN_PARTY");
const IB = `cusdt-bob::${admin.split("::")[1]}`;
const keys = JSON.parse(readFileSync(new URL("./.keys/ext-parties.json", import.meta.url), "utf8"));
const EA = keys["cusdt-ext-alice"];
const REGISTRY = process.env.CUSDT_REGISTRY_URL || "https://registry-testnet.cryptolampung.space";
const token = await getToken();
const auth = { method: "static", token };
const sdk = await (await SDK.create({ auth, ledgerClientUrl: need("LEDGER_URL") })).extend({ token: { auth, registries: [REGISTRY], registryAuth: "none" } });
const asset = (await sdk.token.assets()).find((a) => a.id === "cUSDT");
const short = (e) => String(e?.message ?? e?.response?.data ?? e).replace(/\s+/g, " ");
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const bal = async (p) => (await sdk.token.utxos.list({ partyId: p, includeLocked: true })).reduce((s, h) => s + Math.round(Number(h.interfaceViewValue.amount) * 1e6), 0);
let n = 0;
const out = (s) => console.log(s);

const expected = supply(await snapshot(token, admin));
const b0 = await bal(IB), a0 = await bal(EA.partyId);
out(`start: ext-alice ${a0} micro, internal bob ${b0} micro`);

// 1. the external sender creates the allocation (single external authority: always worked)
const ref = `mixset-${Date.now()}`;
const spec = { settlement: { executor: admin, settlementRef: { id: ref, cid: null }, requestedAt: iso(-30_000), allocateBefore: iso(3_600_000), settleBefore: iso(7_200_000), meta: { values: {} } },
  transferLegId: "leg-1", transferLeg: { sender: EA.partyId, receiver: IB, amount: "0.000001", instrumentId: { admin, id: "cUSDT" }, meta: { values: {} } } };
const [cmd0, disc0] = await sdk.token.allocation.instruction.create({ allocationSpecification: spec, asset });
await sdk.ledger.prepare({ partyId: EA.partyId, commands: [cmd0], disclosedContracts: disc0 ?? [], commandId: `mixset-c-${Date.now()}` }).sign(EA.privateKey).execute({ partyId: EA.partyId });
const alloc = (await sdk.token.allocation.pending(EA.partyId)).find((p) => p.interfaceViewValue.allocation.settlement.settlementRef.id === ref);
out(`allocation created: ${alloc.contractId.slice(0, 16)}...`);

// 2. execute with a MIXED actAs set; only the external party signs
const ex = await sdk.token.allocation.execute({ allocationCid: alloc.contractId, asset });
const cmd = ex.find((x) => x.ExerciseCommand), disclosed = ex.find(Array.isArray) ?? [];
let outcome = "success";
try {
  const prep = await sdk.ledger.internal.prepare({ commands: [cmd], actAs: [admin, EA.partyId, IB], readAs: [], disclosedContracts: disclosed, commandId: `mixset-x-${Date.now()}-${n++}` });
  out(`prepare accepted (hash ${prep.preparedTransactionHash.slice(0, 12)}...)`);
  await ledger(token, "/v2/interactive-submission/executeAndWait", { method: "POST", json: {
    userId: need("LEDGER_USER_ID"), preparedTransaction: prep.preparedTransaction, hashingSchemeVersion: prep.hashingSchemeVersion,
    submissionId: `mixset-${Date.now()}`, deduplicationPeriod: { Empty: {} },
    partySignatures: { signatures: [{ party: EA.partyId, signatures: [{ signature: signTransactionHash(prep.preparedTransactionHash, EA.privateKey), signedBy: EA.partyId.split("::")[1], format: "SIGNATURE_FORMAT_CONCAT", signingAlgorithmSpec: "SIGNING_ALGORITHM_SPEC_ED25519" }] }] } } });
} catch (e) { outcome = "FAILED: " + short(e).slice(-420); }
out(`mixed execute (admin + bob internal, ext-alice signs): ${outcome}`);

const b1 = await bal(IB), a1 = await bal(EA.partyId);
out(`after: ext-alice ${a1} micro (${a1 - a0}), internal bob ${b1} micro (${b1 - b0})`);
const settled = b1 === b0 + 1 && a1 === a0 - 1;
out(settled ? "RESULT: mixed internal+external settlement WORKS" : "RESULT: mixed settlement did not settle");

// 3. clean up whatever is left (the external sender can always withdraw)
const left = (await sdk.token.allocation.pending(EA.partyId)).find((p) => p.interfaceViewValue.allocation.settlement.settlementRef.id === ref);
if (left) { const [wc, wd] = await sdk.token.allocation.withdraw({ allocationCid: left.contractId, asset }); await sdk.ledger.prepare({ partyId: EA.partyId, commands: [wc], disclosedContracts: wd ?? [], commandId: `mixset-w-${Date.now()}` }).sign(EA.privateKey).execute({ partyId: EA.partyId }); out("left-over allocation withdrawn"); }
const exp2 = settled ? expected : expected;
const v = checkInvariants(await snapshot(token, admin), exp2);
out(v.length ? "INVARIANTS BROKEN: " + v.join("; ") : "conservation invariants hold");
