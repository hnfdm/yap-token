// Create a read-only Keycloak client for the registry (testnet) and a matching Ledger API user
// that has ONLY CanReadAs(cusdt-admin).  Idempotent: re-running reuses what exists.
//
// Needs the Keycloak admin login. It is read from a line like
//   "... Keycloak admin console : http://host:port  (admin / <password>)"
// in the file named by KC_ADMIN_NOTES_FILE (default D:\Code\maha-be\.env.val), line KC_ADMIN_NOTES_LINE.
// Nothing secret is printed; the new client's id/secret go to .env.registry (gitignored).
import { readFileSync, writeFileSync } from "node:fs";
import { env, need, getToken, ledger, acs, submit, PKG } from "./lib.mjs";

const REALM = env.KC_REALM || "canton";
const NEW_CLIENT = env.REGISTRY_CLIENT_ID || "cusdt-registry";
const authBase = new URL(need("KC_TOKEN_URL")).origin;
const admin = need("CUSDT_ADMIN_PARTY");

// --- Keycloak admin login ---
const notes = env.KC_ADMIN_NOTES_FILE || "D:\\Code\\maha-be\\.env.val";
const line = readFileSync(notes, "utf8").split(/\r?\n/)[Number(env.KC_ADMIN_NOTES_LINE || 68) - 1] ?? "";
const m = line.match(/\(\s*([^\s/]+)\s*\/\s*([^)\s]+)\s*\)/);
if (!m) throw new Error("could not parse 'admin / password' from the notes line");
const [, kcUser, kcPass] = m;

const tr = await fetch(`${authBase}/realms/master/protocol/openid-connect/token`, {
  method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli", username: kcUser, password: kcPass }),
});
if (!tr.ok) throw new Error(`keycloak admin login failed: ${tr.status}`);
const kcTok = (await tr.json()).access_token;

async function kc(path, { method = "GET", json } = {}) {
  const r = await fetch(`${authBase}/admin/realms/${REALM}${path}`, {
    method, headers: { Authorization: `Bearer ${kcTok}`, ...(json ? { "Content-Type": "application/json" } : {}) },
    body: json ? JSON.stringify(json) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`KC ${method} ${path} -> ${r.status}: ${text.slice(0, 300)}`);
  return { headers: r.headers, body: text ? JSON.parse(text) : null };
}

// --- source client (to copy scopes + mappers from) ---
const srcId = (await kc(`/clients?clientId=${encodeURIComponent(need("KC_CLIENT_ID"))}`)).body[0]?.id;
if (!srcId) throw new Error("source client not found");
const src = (await kc(`/clients/${srcId}`)).body;
const srcScopes = (await kc(`/clients/${srcId}/default-client-scopes`)).body; // [{id,name}]
console.log("source client default scopes:", srcScopes.map((s) => s.name).join(", "));
console.log("source client own mappers:", (src.protocolMappers ?? []).map((p) => p.name).join(", ") || "(none)");

// --- create (or reuse) the read-only client ---
let newId = (await kc(`/clients?clientId=${encodeURIComponent(NEW_CLIENT)}`)).body[0]?.id;
if (!newId) {
  const created = await kc("/clients", {
    method: "POST",
    json: {
      clientId: NEW_CLIENT, name: "cUSDT registry (read-only)", enabled: true, protocol: "openid-connect",
      publicClient: false, serviceAccountsEnabled: true,
      standardFlowEnabled: false, implicitFlowEnabled: false, directAccessGrantsEnabled: false,
      clientAuthenticatorType: "client-secret",
      protocolMappers: (src.protocolMappers ?? []).map(({ id, ...rest }) => rest),
    },
  });
  newId = created.headers.get("location").split("/").pop();
  console.log("created client", NEW_CLIENT);
} else console.log("client", NEW_CLIENT, "already exists");

const have = new Set((await kc(`/clients/${newId}/default-client-scopes`)).body.map((s) => s.name));
for (const s of srcScopes) if (!have.has(s.name)) await kc(`/clients/${newId}/default-client-scopes/${s.id}`, { method: "PUT" });

const secret = (await kc(`/clients/${newId}/client-secret`)).body.value;
const saUser = (await kc(`/clients/${newId}/service-account-user`)).body.id;
console.log("service account user id (= ledger user id):", saUser);

// --- ledger user with CanReadAs(cusdt-admin) only ---
const adminTok = await getToken();
try {
  await ledger(adminTok, "/v2/users", {
    method: "POST",
    json: {
      user: { id: saUser, isDeactivated: false, primaryParty: "", identityProviderId: "" },
      rights: [{ kind: { CanReadAs: { value: { party: admin } } } }],
    },
  });
  console.log("ledger user created with CanReadAs only");
} catch (e) {
  if (/ALREADY_EXISTS|already exists/i.test(String(e.message))) console.log("ledger user already exists");
  else throw e;
}

writeFileSync(new URL("../.env.registry", import.meta.url), `KC_CLIENT_ID=${NEW_CLIENT}\nKC_CLIENT_SECRET=${secret}\n`);
console.log("wrote .env.registry (client id + secret), gitignored");

// --- verify: same token shape, can read, cannot write ---
const claims = (t) => JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString());
const form = (id, sec) => new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: sec, scope: env.KC_SCOPE || "daml_ledger_api" });
const tokOf = async (id, sec) => (await (await fetch(need("KC_TOKEN_URL"), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form(id, sec) })).json()).access_token;
const roTok = await tokOf(NEW_CLIENT, secret);
const a = claims(adminTok), b = claims(roTok);
const norm = (c) => JSON.stringify({ aud: [].concat(c.aud ?? []).sort(), scope: String(c.scope ?? "").split(" ").sort() });
console.log("token aud/scope identical to admin client:", norm(a) === norm(b));

const factories = await acs(roTok, admin, `${PKG}:CusdtToken:CusdtTransferFactory`, { blob: true });
console.log("READ  factory with read-only token:", factories.length === 1 ? "OK" : `UNEXPECTED (${factories.length})`);

const [adm] = await acs(adminTok, admin, `${PKG}:CusdtToken:CusdtAdmin`);
try {
  await submit(roTok, { actAs: [admin], label: "ro-must-fail", commands: [{ ExerciseCommand: {
    templateId: `${PKG}:CusdtToken:CusdtAdmin`, contractId: adm.contractId, choice: "CusdtAdmin_Mint",
    choiceArgument: { recipient: admin, amount: "1.0000000000" } } }] });
  console.log("WRITE with read-only token: !!! SUCCEEDED (rights too broad)");
  process.exitCode = 1;
} catch (e) {
  console.log("WRITE with read-only token: denied as expected ->", String(e.message).slice(0, 110));
}
