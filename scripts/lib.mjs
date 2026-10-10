// Shared helpers for cUSDT testnet scripts. Reads .env.testnet from the repo root.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function loadEnv(file = ".env.testnet") {
  const env = { ...process.env };
  try {
    for (const line of readFileSync(join(root, file), "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in env && env[m[1]])) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* no file: rely on process env */ }
  return env;
}

export const env = loadEnv();
export const need = (k) => { if (!env[k]) throw new Error(`missing env ${k}`); return env[k]; };
export const PKG = env.CUSDT_PACKAGE_NAME || "#cusdt-token";

// Self-signed / domain-fronted testnet endpoints: set INSECURE_TLS=1 for local testing only.
if (env.INSECURE_TLS === "1") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

export async function getToken() {
  const r = await fetch(need("KC_TOKEN_URL"), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials", client_id: need("KC_CLIENT_ID"),
      client_secret: need("KC_CLIENT_SECRET"), scope: env.KC_SCOPE || "daml_ledger_api",
    }),
  });
  if (!r.ok) throw new Error(`token ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).access_token;
}

export async function ledger(token, path, { method = "GET", json, raw, ct } = {}) {
  const r = await fetch(`${need("LEDGER_URL")}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(json ? { "Content-Type": "application/json" } : {}), ...(ct ? { "Content-Type": ct } : {}) },
    body: json ? JSON.stringify(json) : raw,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

export async function ledgerEnd(token) {
  return (await ledger(token, "/v2/state/ledger-end")).offset;
}

// Active contracts for a party, narrow template filter (JSON API caps ACS at 200 elements).
export async function acs(token, party, templateId, { blob = false } = {}) {
  const offset = await ledgerEnd(token);
  const r = await ledger(token, "/v2/state/active-contracts", {
    method: "POST",
    json: {
      activeAtOffset: offset,
      eventFormat: {
        filtersByParty: { [party]: { cumulative: [{ identifierFilter: { TemplateFilter: { value: { templateId, includeCreatedEventBlob: blob } } } }] } },
        verbose: true,
      },
    },
  });
  const items = Array.isArray(r) ? r : (r.activeContracts ?? []);
  return items.map((it) => {
    const a = it.contractEntry?.JsActiveContract;
    return { ...a?.createdEvent, synchronizerId: a?.synchronizerId };
  }).filter((c) => c.contractId);
}

let _cmdSeq = 0;
/** commandId is unique per call (concurrent submissions in the same millisecond must not collide); pass `commandId` to test deduplication. */
export function submit(token, { actAs, readAs = actAs, commands, disclosedContracts = [], label, commandId }) {
  return ledger(token, "/v2/commands/submit-and-wait", {
    method: "POST",
    json: { commands, actAs, readAs, disclosedContracts, commandId: commandId ?? `cusdt-${label}-${Date.now()}-${++_cmdSeq}-${Math.random().toString(36).slice(2, 8)}` },
  });
}
