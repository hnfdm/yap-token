// Prototype: read active contracts through the WEBSOCKET stream of the JSON Ledger API (no 200-element cap on streams) and compare with the HTTP list.
//   node scripts/31-ws-active-contracts.mjs [template=YapHolding] [party=admin]        needs Node >= 22 (global WebSocket)
// Streaming endpoint: ws(s)://<ledger>/v2/state/active-contracts, subprotocols ["jwt.token.<jwt>", "daml.ws.auth"], first message = the same JSON body as the HTTP POST.
import { loadEnv } from "./lib.mjs";
import { node } from "./nodes.mjs";

const E = loadEnv(".env.testnet"); if (E.INSECURE_TLS === "1") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const n = node(E, "ours"), admin = E.CUSDT_ADMIN_PARTY;
const tplName = process.argv[2] ?? "YapHolding", party = process.argv[3] ?? admin;
const templateId = `#yap-token:YapToken:${tplName}`;

export async function wsActiveContracts(nd, cfg, party, templateId, { timeoutMs = 60_000, blob = false } = {}) {
  const off = (await nd.ledger("/v2/state/ledger-end")).offset;
  const url = cfg.LEDGER_URL.replace(/^http/, "ws") + "/v2/state/active-contracts";
  const ws = new WebSocket(url, ["jwt.token." + await nd.token(), "daml.ws.auth"]);
  const out = []; let done;
  const p = new Promise((res, rej) => { done = { res, rej }; });
  const timer = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } done.rej(new Error(`websocket timeout after ${timeoutMs} ms with ${out.length} contracts`)); }, timeoutMs);
  ws.onopen = () => ws.send(JSON.stringify({ activeAtOffset: off, eventFormat: { filtersByParty: { [party]: { cumulative: [{ identifierFilter: { TemplateFilter: { value: { templateId, includeCreatedEventBlob: blob } } } }] } }, verbose: true } }));
  ws.onmessage = (m) => { let j; try { j = JSON.parse(m.data); } catch { return; }
    if (j.code && j.cause) { clearTimeout(timer); ws.close(); return done.rej(new Error(`${j.code}: ${String(j.cause).slice(0, 200)}`)); }
    const ce = j.contractEntry?.JsActiveContract?.createdEvent; if (ce) out.push(ce); };
  ws.onerror = (e) => { clearTimeout(timer); done.rej(new Error("websocket error: " + (e.message ?? e.type))); };
  ws.onclose = () => { clearTimeout(timer); done.res(out); };
  return p;
}

if (import.meta.url === new URL(process.argv[1], "file:///").href.replace("file:////", "file:///") || process.argv[1].endsWith("31-ws-active-contracts.mjs")) {
  const t0 = Date.now();
  const viaWs = await wsActiveContracts(n, E, party, templateId);
  console.log(`websocket: ${viaWs.length} ${tplName} contracts for ${party.split("::")[0]} in ${Date.now() - t0} ms`);
  const t1 = Date.now();
  let viaHttp; try { viaHttp = (await n.acs(party, templateId)).length; } catch (e) { viaHttp = "ERROR " + String(e.message).slice(-150); }
  console.log(`http list: ${viaHttp} in ${Date.now() - t1} ms`);
  if (typeof viaHttp === "number") console.log(viaHttp === viaWs.length ? "PASS  websocket and HTTP agree" : "FAIL  counts differ");
}
