// Read-only statistics of the YAP instance from the ledger: completed transfers and volume per day, per venue marker, unique senders and
// receivers, allocation settlements. The admin (cusdt-gov) is signatory of every YAP contract, so its update stream is the full history.
//   node scripts/51-yap-stats.mjs [--json]        (.env.testnet = t1; no traffic cost, only reads)
// Definitions:
//   transfer   = a completed move of YAP between two DIFFERENT owners: a direct transfer (preapproval) or an accepted offer.
//                Pending, rejected and withdrawn offers are not counted. Self transfers (merge/split) are counted apart.
//   volume     = sum of the transfer amounts (no double counting: an offer counts once, when it is accepted).
//   admin sends = transfers whose sender is the admin itself (treasury distributions); shown apart from user transfers.
//   settlement = SettlementFactory_SettleBatch (Allocation V2) and Allocation_ExecuteTransfer (V1); volume = sum of the legs.
//   not counted: mints, vesting claims, locks, burns.
//   venue      = the value of any transfer.meta key ending in "/venue" (for example maha/venue = maha), else "(none)".
import { loadEnv } from "./lib.mjs";
import { node } from "./nodes.mjs";

const E = loadEnv(".env.testnet"); if (E.INSECURE_TLS === "1") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const n = node(E, "t1");
const GOV = E.CUSDT_GOV_PARTY ?? "cusdt-gov::12205fb8f032bfcfe6ae4ae3a7625629fe9065668ee529e3a785691e1cdce5022c2b";
const JSON_OUT = process.argv.includes("--json");
const owner = (x) => (typeof x === "string" ? x : x?.owner);
const mu = (a) => Math.round(Number(a) * 1e6);
const tail = (tid) => tid.split(":").slice(1).join(":");
const venueOf = (meta) => { const v = meta?.values ?? {}; const k = Object.keys(v).find((x) => x.endsWith("/venue")); return k ? v[k] : "(none)"; };
const day = (iso) => iso.slice(0, 10);

const end = (await n.ledger("/v2/state/ledger-end")).offset;
const instances = new Map();            // contractId -> { transfer } for pending YapTransferInstruction / allocations
const rows = [];                         // completed transfers
const selfT = { n: 0, vol: 0 }, settle = [];
const rec = (t, at, via) => {
  const s = owner(t.sender), r = owner(t.receiver), a = mu(t.amount);
  if (s === r) { selfT.n++; selfT.vol += a; return; }
  rows.push({ day: day(at), sender: s, receiver: r, amount: a, venue: venueOf(t.meta), admin: s === GOV, via });
};
let begin = 0, txs = 0;
for (;;) {
  const r = await n.ledger("/v2/updates?limit=200", { method: "POST", json: { beginExclusive: begin, endInclusive: end, updateFormat: { includeTransactions: { eventFormat: { filtersByParty: { [GOV]: {} }, verbose: true }, transactionShape: "TRANSACTION_SHAPE_LEDGER_EFFECTS" } } } });
  if (!r.length) break;
  for (const u of r) {
    const t = u.update?.Transaction?.value;
    if (!t) { begin = Math.max(begin, u.update?.OffsetCheckpoint?.value?.offset ?? begin); continue; }
    txs++; begin = Math.max(begin, t.offset);
    for (const ev of t.events) {
      const c = ev.CreatedEvent;
      if (c && /:YapToken:(YapTransferInstruction|YapAllocation)$/.test(tail(c.templateId).replace(/^/, ":"))) instances.set(c.contractId, c.createArgument);
      const x = ev.ExercisedEvent; if (!x) continue;
      const tn = tail(x.templateId), at = t.effectiveAt;
      if (tn === "YapToken:YapTransferFactory" && x.choice === "TransferFactory_Transfer") {
        const tr = x.choiceArgument.transfer;
        if (tr.instrumentId?.id === "YAP" && x.exerciseResult?.output?.tag === "TransferInstructionResult_Completed") rec(tr, at, "direct");
      } else if (tn === "YapToken:YapTransferInstruction" && x.choice === "TransferInstruction_Accept") {
        const tr = instances.get(x.contractId)?.transfer;
        if (tr && tr.instrumentId?.id === "YAP") rec(tr, at, "offer");
      } else if (tn === "YapToken:YapSettlementFactory" && x.choice === "SettlementFactory_SettleBatch") {
        const legs = (x.choiceArgument.transferLegs ?? []).filter((l) => l.instrumentId === "YAP" || l.instrumentId?.id === "YAP");
        settle.push({ day: day(at), kind: "V2 batch", legs: legs.length, vol: legs.reduce((s, l) => s + mu(l.amount), 0) });
      } else if (tn === "YapToken:YapAllocation" && x.choice === "Allocation_ExecuteTransfer") {
        const leg = instances.get(x.contractId)?.allocation?.transferLeg;
        if (leg) settle.push({ day: day(at), kind: "V1 execute", legs: 1, vol: mu(leg.amount) });
      }
    }
  }
  if (r.length < 200) break;
}

const by = (arr, f) => { const m = new Map(); for (const x of arr) { const k = f(x); const o = m.get(k) ?? { n: 0, vol: 0 }; o.n++; o.vol += x.amount ?? x.vol; m.set(k, o); } return m; };
const fmt = (m) => (m / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 });
const user = rows.filter((r) => !r.admin), adm = rows.filter((r) => r.admin);
const sum = (a) => a.reduce((s, r) => s + r.amount, 0);
const out = {
  transactions_read: txs,
  completed_transfers: { count: rows.length, volume_yap: sum(rows) / 1e6, user: { count: user.length, volume_yap: sum(user) / 1e6 }, admin_sends: { count: adm.length, volume_yap: sum(adm) / 1e6 } },
  self_transfers: { count: selfT.n, volume_yap: selfT.vol / 1e6 },
  unique_senders: new Set(rows.map((r) => r.sender)).size, unique_receivers: new Set(rows.map((r) => r.receiver)).size,
  per_day: Object.fromEntries([...by(rows, (r) => r.day)].sort().map(([k, v]) => [k, { count: v.n, volume_yap: v.vol / 1e6 }])),
  per_venue: Object.fromEntries([...by(rows, (r) => r.venue)].map(([k, v]) => [k, { count: v.n, volume_yap: v.vol / 1e6 }])),
  per_path: Object.fromEntries([...by(rows, (r) => r.via)].map(([k, v]) => [k, { count: v.n, volume_yap: v.vol / 1e6 }])),
  settlements: { count: settle.length, volume_yap: settle.reduce((s, x) => s + x.vol, 0) / 1e6 },
};
if (JSON_OUT) { console.log(JSON.stringify(out, null, 1)); process.exit(0); }
console.log(`YAP statistics from ${txs} ledger transactions of ${GOV.split("::")[0]}\n`);
console.log(`completed transfers: ${out.completed_transfers.count}  volume ${fmt(sum(rows))} YAP`);
console.log(`   user transfers:   ${user.length}  volume ${fmt(sum(user))} YAP`);
console.log(`   admin sends:      ${adm.length}  volume ${fmt(sum(adm))} YAP  (treasury distributions)`);
console.log(`self transfers (merge/split, not counted above): ${selfT.n}  ${fmt(selfT.vol)} YAP`);
console.log(`unique senders ${out.unique_senders}, unique receivers ${out.unique_receivers}`);
console.log(`allocation settlements: ${settle.length}  leg volume ${fmt(settle.reduce((s, x) => s + x.vol, 0))} YAP\n`);
console.log("per day:");   for (const [k, v] of Object.entries(out.per_day)) console.log(`   ${k}  ${String(v.count).padStart(4)} transfers  ${v.volume_yap.toLocaleString("en-US", { maximumFractionDigits: 6 })} YAP`);
console.log("per venue marker:"); for (const [k, v] of Object.entries(out.per_venue)) console.log(`   ${k.padEnd(14)} ${String(v.count).padStart(4)} transfers  ${v.volume_yap.toLocaleString("en-US", { maximumFractionDigits: 6 })} YAP`);
console.log("per path:");  for (const [k, v] of Object.entries(out.per_path)) console.log(`   ${k.padEnd(14)} ${String(v.count).padStart(4)} transfers`);
