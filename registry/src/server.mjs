// Off-ledger registry API for cUSDT (Canton Token Standard / CIP-56).
// Implements the token-metadata-v1 and transfer-instruction-v1 OpenAPI specs from Splice.
// Plain JS, zero dependencies (Node >= 18): node:http + global fetch.
import { createServer } from "node:http";

const PORT       = Number(process.env.PORT ?? 8787);
const HOST       = process.env.HOST ?? "127.0.0.1";
const LEDGER_URL = process.env.LEDGER_URL ?? "";
const KC_URL     = process.env.KC_TOKEN_URL ?? "";
const KC_CLIENT  = process.env.KC_CLIENT_ID ?? "";
const KC_SECRET  = process.env.KC_CLIENT_SECRET ?? "";
const KC_SCOPE   = process.env.KC_SCOPE ?? "daml_ledger_api";
const ADMIN      = process.env.CUSDT_ADMIN_PARTY ?? "";
const PKG        = process.env.CUSDT_PACKAGE_NAME ?? "#cusdt-token";
const SYMBOL     = "cUSDT";

const SUPPORTED_APIS = {
  "splice-api-token-metadata-v1": 1,
  "splice-api-token-holding-v1": 1,
  "splice-api-token-transfer-instruction-v1": 1,
  "splice-api-token-allocation-v1": 1,
  "splice-api-token-allocation-instruction-v1": 1,
};

const INSTRUMENT = {
  id: SYMBOL, name: "cUSDT (test)", symbol: SYMBOL, decimals: 6,
  paused: false, supportedApis: SUPPORTED_APIS,
};

// ---- ledger access (read-only, as the admin party) ------------------------

let tok = null;
async function ledgerToken() {
  const now = Date.now() / 1000;
  if (tok && tok.exp > now + 60) return tok.value;
  const r = await fetch(KC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: KC_CLIENT, client_secret: KC_SECRET, scope: KC_SCOPE }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`token endpoint ${r.status}`);
  const j = await r.json();
  tok = { value: j.access_token, exp: now + (j.expires_in ?? 300) };
  return tok.value;
}

const singletonCache = new Map();
const findFactory = () => findSingleton("CusdtTransferFactory");
const findAllocationFactory = () => findSingleton("CusdtAllocationFactory");

async function findSingleton(tpl) {
  const hit = singletonCache.get(tpl);
  if (hit && Date.now() - hit.ts < 5_000) return hit.d;
  const t = await ledgerToken();
  const h = { "Content-Type": "application/json", Authorization: `Bearer ${t}` };
  const end = await (await fetch(`${LEDGER_URL}/v2/state/ledger-end`, { headers: h, signal: AbortSignal.timeout(10_000) })).json();
  const res = await fetch(`${LEDGER_URL}/v2/state/active-contracts`, {
    method: "POST", headers: h, signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      activeAtOffset: end.offset,
      eventFormat: {
        filtersByParty: { [ADMIN]: { cumulative: [{ identifierFilter: { TemplateFilter: { value: {
          templateId: `${PKG}:CusdtToken:${tpl}`, includeCreatedEventBlob: true } } } }] } },
        verbose: true,
      },
    }),
  });
  if (!res.ok) throw new Error(`ACS ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const parsed = JSON.parse(await res.text());
  const items = Array.isArray(parsed) ? parsed : (parsed.activeContracts ?? []);
  for (const it of items) {
    const a = it.contractEntry?.JsActiveContract;
    const ce = a?.createdEvent;
    if (ce?.contractId && ce.createdEventBlob) {
      const d = { templateId: ce.templateId, contractId: ce.contractId, createdEventBlob: ce.createdEventBlob, synchronizerId: a.synchronizerId ?? "" };
      singletonCache.set(tpl, { d, ts: Date.now() });
      return d;
    }
  }
  throw new Error(`${tpl} contract not found on ledger`);
}

// Receiver's direct-transfer preapproval (admin is signatory, so it sees every one).
// Fresh lookup per request: a cached cid would break the transfer as soon as it is cancelled.
const PREAPPROVAL_KEY = "cusdt.mahawallet.xyz/transfer-preapproval";

async function findPreapproval(receiver) {
  const t = await ledgerToken();
  const h = { "Content-Type": "application/json", Authorization: `Bearer ${t}` };
  const end = await (await fetch(`${LEDGER_URL}/v2/state/ledger-end`, { headers: h, signal: AbortSignal.timeout(10_000) })).json();
  const res = await fetch(`${LEDGER_URL}/v2/state/active-contracts`, {
    method: "POST", headers: h, signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      activeAtOffset: end.offset,
      eventFormat: {
        filtersByParty: { [ADMIN]: { cumulative: [{ identifierFilter: { TemplateFilter: { value: {
          templateId: `${PKG}:CusdtToken:CusdtTransferPreapproval`, includeCreatedEventBlob: true } } } }] } },
        verbose: true,
      },
    }),
  });
  if (!res.ok) throw new Error(`ACS ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const parsed = JSON.parse(await res.text());
  const items = Array.isArray(parsed) ? parsed : (parsed.activeContracts ?? []);
  for (const it of items) {
    const a = it.contractEntry?.JsActiveContract;
    const ce = a?.createdEvent;
    if (ce?.createArgument?.receiver === receiver && ce.createdEventBlob) {
      return { templateId: ce.templateId, contractId: ce.contractId, createdEventBlob: ce.createdEventBlob, synchronizerId: a.synchronizerId ?? "" };
    }
  }
  return null;
}

// ---- http plumbing ----------------------------------------------------------

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 256 * 1024) throw new HttpError(413, "request body too large");
    chunks.push(c);
  }
  const s = Buffer.concat(chunks).toString();
  let v; try { v = s ? JSON.parse(s) : {}; } catch { throw new HttpError(400, "invalid JSON"); }
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "body must be a JSON object");
  return v;
}

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(data));
}

const emptyContext = { choiceContextData: { values: {} }, disclosedContracts: [] };

async function route(req, res) {
  const url = new URL(req.url ?? "/", "http://x");
  let p = url.pathname;
  // Utility-registry style URLs (what existing tooling expects):
  //   /api/token-standard/v0/registrars/<admin>/registry/...  ==  /registry/...
  const alias = p.match(/^\/api\/token-standard\/v0\/registrars\/([^/]+)(\/registry\/.*)$/);
  if (alias) {
    let who = alias[1];
    try { who = decodeURIComponent(who); } catch { /* keep raw */ }
    if (who !== ADMIN) throw new HttpError(404, "unknown registrar");
    p = alias[2];
  }
  const m = req.method ?? "GET";

  if (m === "OPTIONS") return send(res, 204, {});
  if (m === "GET" && p === "/health") return send(res, 200, { ok: true, admin: ADMIN });

  // token-metadata-v1
  if (m === "GET" && p === "/registry/metadata/v1/info")
    return send(res, 200, { adminId: ADMIN, supportedApis: SUPPORTED_APIS });
  if (m === "GET" && p === "/registry/metadata/v1/instruments")
    return send(res, 200, { instruments: [INSTRUMENT] });
  if (m === "GET" && p === `/registry/metadata/v1/instruments/${SYMBOL}`)
    return send(res, 200, INSTRUMENT);

  // transfer-instruction-v1
  if (m === "POST" && p === "/registry/transfer-instruction/v1/transfer-factory") {
    const b = await body(req);
    const ca = b.choiceArguments;
    const tr = ca?.transfer;
    if (!tr) throw new HttpError(400, "choiceArguments.transfer required");
    if (ca.expectedAdmin !== ADMIN) throw new HttpError(400, "expectedAdmin does not match this registry");
    if (tr.instrumentId?.admin !== ADMIN || tr.instrumentId?.id !== SYMBOL)
      throw new HttpError(404, "unknown instrument");
    const d = await findFactory();
    if (typeof tr.sender !== "string" || typeof tr.receiver !== "string" || !tr.receiver)
      throw new HttpError(400, "transfer.sender and transfer.receiver must be party id strings");
    if (tr.sender === tr.receiver)
      return send(res, 200, { factoryId: d.contractId, transferKind: "self",
        choiceContext: { choiceContextData: { values: {} }, disclosedContracts: [d] } });
    // A failing/capped preapproval lookup must not take transfers down: fall back to a plain offer.
    let pre = null;
    try { pre = await findPreapproval(tr.receiver); }
    catch (e) { console.error("[cusdt-registry] preapproval lookup failed, falling back to offer:", String(e.message).slice(0, 200)); }
    if (pre)
      return send(res, 200, { factoryId: d.contractId, transferKind: "direct",
        choiceContext: {
          choiceContextData: { values: { [PREAPPROVAL_KEY]: { tag: "AV_ContractId", value: pre.contractId } } },
          disclosedContracts: [d, pre],
        } });
    return send(res, 200, { factoryId: d.contractId, transferKind: "offer",
      choiceContext: { choiceContextData: { values: {} }, disclosedContracts: [d] } });
  }
  // allocation-instruction-v1
  if (m === "POST" && p === "/registry/allocation-instruction/v1/allocation-factory") {
    const b = await body(req);
    const ca = b.choiceArguments;
    const leg = ca?.allocation?.transferLeg;
    if (!leg) throw new HttpError(400, "choiceArguments.allocation.transferLeg required");
    if (ca.expectedAdmin !== ADMIN) throw new HttpError(400, "expectedAdmin does not match this registry");
    if (leg.instrumentId?.admin !== ADMIN || leg.instrumentId?.id !== SYMBOL)
      throw new HttpError(404, "unknown instrument");
    const d = await findAllocationFactory();
    return send(res, 200, { factoryId: d.contractId, choiceContext: { choiceContextData: { values: {} }, disclosedContracts: [d] } });
  }
  // allocation-v1: no extra context needed for any choice
  if (m === "POST" && /^\/registry\/allocations\/v1\/[^/]+\/choice-contexts\/(execute-transfer|withdraw|cancel)$/.test(p))
    return send(res, 200, emptyContext);

  const cc = p.match(/^\/registry\/transfer-instruction\/v1\/([^/]+)\/choice-contexts\/(accept|reject|withdraw)$/);
  if (m === "POST" && cc) return send(res, 200, emptyContext);

  throw new HttpError(404, `no route ${m} ${p}`);
}

if (!LEDGER_URL || !ADMIN || !KC_URL || !KC_CLIENT || !KC_SECRET) {
  console.error("Set LEDGER_URL, KC_TOKEN_URL, KC_CLIENT_ID, KC_CLIENT_SECRET, CUSDT_ADMIN_PARTY");
  process.exit(1);
}

createServer((req, res) => {
  route(req, res).catch((e) => {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error("[cusdt-registry]", e);
    send(res, status, { error: e instanceof Error ? e.message : String(e) });
  });
}).listen(PORT, HOST, () => console.log(`[cusdt-registry] listening on ${HOST}:${PORT}, admin=${ADMIN.slice(0, 30)}...`));
