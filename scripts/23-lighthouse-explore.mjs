// Read-only: what does the Lighthouse TESTNET explorer know about YAP, and what can it tell us that the ledger can't?
//   node scripts/23-lighthouse-explore.mjs
// Reads are public; the key (LIGHTHOUSE_API_KEY in .env.testnet) is only sent as `Authorization: Bearer` for attribution and is never printed.
import { env, need } from "./lib.mjs";

const BASE = "https://lighthouse.testnet.cantonloop.com/api";
const KEY = env.LIGHTHOUSE_API_KEY;
const admin = need("CUSDT_ADMIN_PARTY"), suffix = admin.split("::")[1];
const ALICE = `cusdt-alice::${suffix}`, BOB = `cusdt-bob::${suffix}`;
const VAL = `asc-val-1::${suffix}`;
const MZF_VAL = "mzf-validator-1::1220501bc43d60c4293f8ff9c9d114a1e7e0b96dfb9f0c366ed27193737b45b05a56";
const CAROL = env.CUSDT_MZF_CAROL ?? `cusdt-mzf-carol::${MZF_VAL.split("::")[1]}`;
const enc = (s) => encodeURIComponent(s);

async function get(path, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    const t0 = Date.now();
    try {
      const r = await fetch(`${BASE}${path}`, { headers: KEY ? { Authorization: `Bearer ${KEY}` } : {}, signal: AbortSignal.timeout(30_000) });
      const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      if (r.status >= 500 || r.status === 429) throw new Error(`HTTP ${r.status}`);
      return { status: r.status, json, text, ms: Date.now() - t0 };
    } catch (e) { if (i === tries) return { status: 0, json: null, text: String(e.message), ms: Date.now() - t0 }; await new Promise((r) => setTimeout(r, 2500 * i)); }
  }
}
const clip = (v, n = 230) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s.length > n ? s.slice(0, n) + "…" : s; };
const arr = (j) => Array.isArray(j) ? j : (j?.items ?? j?.data ?? j?.results ?? j?.tokens ?? j?.transactions ?? j?.movements ?? j?.activity ?? []);
async function section(title, path, show) {
  const r = await get(path);
  console.log(`\n== ${title}   [${r.status || "no answer"} in ${r.ms} ms]  GET ${path.replace(/%3A%3A[0-9a-f]{20,}/g, "::…")}`);
  if (!r.json) { console.log("   ", clip(r.text, 200)); return r; }
  try { show?.(r.json); } catch (e) { console.log("    (could not summarise:", e.message + ")"); console.log("    raw:", clip(r.json)); }
  return r;
}

console.log(`Lighthouse testnet, API key supplied: ${KEY ? "yes (not shown)" : "no"}`);
await section("network config", "/network-config", (j) => console.log("   ", clip(j, 500)));
await section("chain stats", "/stats", (j) => console.log("   ", clip(j, 500)));

const tokens = await section("token list (is YAP a known token?)", "/tokens/list", (j) => {
  const list = arr(j); console.log(`    ${list.length} tokens; keys of one: ${Object.keys(list[0] ?? {}).join(", ")}`);
  console.log("    names:", list.map((t) => t.name ?? t.symbol ?? t.id).slice(0, 25).join(", "));
  const hit = list.filter((t) => /cusdt|usdt/i.test(JSON.stringify(t))); console.log("    YAP/USDT-like entries:", hit.length ? clip(hit) : "none");
});
await section("search 'cusdt'", "/search?q=cusdt", (j) => console.log("   ", clip(j, 700)));
await section("search the admin party", `/search?q=${enc(admin)}`, (j) => console.log("   ", clip(j, 500)));
await section("token overview 'YAP'", "/tokens/YAP/overview", (j) => console.log("   ", clip(j, 500)));

for (const [label, p] of [["cusdt-admin", admin], ["cusdt-alice", ALICE], ["cusdt-mzf-carol (other node)", CAROL]]) {
  await section(`party ${label}`, `/parties/${enc(p)}`, (j) => console.log("   ", clip(Object.fromEntries(Object.entries(j).filter(([k]) => /id|address|hosted|multi|name|type|created|first|last|balance/i.test(k))), 450)));
  await section(`CIP-56 activity of ${label}`, `/parties/${enc(p)}/cip56-activity?limit=5`, (j) => { const a = arr(j); console.log(`    ${a.length} item(s); first: ${clip(a[0] ?? j, 420)}`); });
}
await section("token movements for instrument YAP (admin filter)", `/token-movements?admin=${enc(admin)}&instrument_id=YAP&limit=5`, (j) => { const a = arr(j); console.log(`    ${a.length} movement(s); first: ${clip(a[0] ?? j, 420)}`); });
await section("token movements of alice", `/token-movements?party=${enc(ALICE)}&limit=5`, (j) => { const a = arr(j); console.log(`    ${a.length} movement(s); first: ${clip(a[0] ?? j, 420)}`); });

// one of OUR transactions in detail: how is it shown, what did it cost?
const tx = await section("alice's latest transactions", `/parties/${enc(ALICE)}/tx?limit=12`, (j) => {
  const a = arr(j); console.log(`    ${a.length} tx; choices seen: ${[...new Set(a.map((t) => t.choice))].join(", ")}`);
  for (const t of a.slice(0, 6)) console.log(`      ${String(t.record_time ?? "").slice(0, 19)}  ${t.choice}  acting: ${(t.acting_parties ?? []).map((p) => p.split("::")[0]).join("+")}`);
});
const txs = arr(tx.json);
const pick = txs.find((t) => /TransferFactory_Transfer|Allocation|TransferInstruction_Accept/.test(t.choice ?? "")) ?? txs[0];
if (pick?.update_id) {
  await section(`one transaction in detail (${pick.choice})`, `/transactions/${enc(pick.update_id)}`, (j) => {
    console.log("    top-level keys:", Object.keys(j).join(", "));
    const v = j.verdict ?? {}; console.log("    verdict:", clip({ result: v.result ?? v.status, submitting_parties: v.submitting_parties?.map?.((p) => p.split("::")[0]), traffic_summary: v.traffic_summary }, 420));
    console.log("    traffic cost field:", clip(j.transaction?.traffic_cost ?? j.traffic_cost ?? "(none)", 200));
    const ev = j.events ?? j.transaction?.events ?? {}; const evs = Array.isArray(ev) ? ev : Object.values(ev);
    console.log(`    ${evs.length} event(s) in the tree; templates: ${[...new Set(evs.map((e) => String(e.template_id ?? e.templateId ?? "").split(":").slice(-2).join(":")))].slice(0, 8).join(" | ")}`);
  });
}

for (const [label, p] of [["asc-val-1 (ours)", VAL], ["mzf-validator-1", MZF_VAL]]) {
  await section(`validator ${label}`, `/validators/${enc(p)}`, (j) => console.log("   ", clip({ balance: j.balance, traffic_status: j.traffic_status, version: j.validator?.version, last_active_round: j.validator?.last_active_round, miss_round: j.validator?.miss_round }, 520)));
}
await section("preapprovals list (shape only)", "/preapprovals?limit=2", (j) => { const a = arr(j); console.log(`    ${a.length} item(s); first: ${clip(a[0] ?? j, 300)}`); });
