// A tiny client for ONE participant (auto-refreshing 5-minute token). Used by the cross-participant tests.
import { retry, retrySend } from "./invariants.mjs";

export function node(cfg, name) {
  let tok = null;
  const token = async () => {
    if (tok && tok.exp > Date.now() / 1000 + 60) return tok.v;
    const r = await retry(() => fetch(cfg.KC_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },   // a token request is safe to retry
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: cfg.KC_CLIENT_ID, client_secret: cfg.KC_CLIENT_SECRET, scope: cfg.KC_SCOPE || "daml_ledger_api" }) }));
    if (!r.ok) throw new Error(`${name} token ${r.status}`);
    const j = await r.json(); tok = { v: j.access_token, exp: Date.now() / 1000 + (j.expires_in ?? 300) }; return tok.v;
  };
  const ledger = async (path, { method = "GET", json } = {}) => {
    const r = await fetch(`${cfg.LEDGER_URL}${path}`, { method, headers: { Authorization: `Bearer ${await token()}`, ...(json ? { "Content-Type": "application/json" } : {}) }, body: json ? JSON.stringify(json) : undefined });
    const text = await r.text(); if (!r.ok) throw new Error(`${name} ${method} ${path} -> ${r.status}: ${text.slice(0, 500)}`); return text ? JSON.parse(text) : {};
  };
  const acs = (party, tpl, blob = false) => retry(async () => {
    const off = (await ledger("/v2/state/ledger-end")).offset;
    const r = await ledger("/v2/state/active-contracts", { method: "POST", json: { activeAtOffset: off, eventFormat: { filtersByParty: { [party]: { cumulative: [{ identifierFilter: { TemplateFilter: { value: { templateId: tpl, includeCreatedEventBlob: blob } } } }] } }, verbose: true } } });
    return (Array.isArray(r) ? r : (r.activeContracts ?? [])).map((it) => ({ ...it.contractEntry?.JsActiveContract?.createdEvent, synchronizerId: it.contractEntry?.JsActiveContract?.synchronizerId })).filter((c) => c.contractId);
  });
  let n = 0;
  const tx = (actAs, commands, disclosed = []) => retrySend(() => ledger("/v2/commands/submit-and-wait-for-transaction", { method: "POST", json: {
    commands: { commands, commandId: `xp-${name}-${Date.now()}-${n++}`, actAs, readAs: actAs, disclosedContracts: disclosed },
    transactionFormat: { transactionShape: "TRANSACTION_SHAPE_LEDGER_EFFECTS", eventFormat: { filtersByParty: Object.fromEntries(actAs.map((p) => [p, {}])), verbose: true } } } }));
  return { token, ledger, acs, tx };
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const waitFor = async (fn, ms = 90_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return { v, s: Math.round((Date.now() - t0) / 1000) }; await sleep(3000); } return { v: null, s: Math.round(ms / 1000) }; };
