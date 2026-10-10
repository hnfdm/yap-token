// Read-only TLS diagnosis of the testnet endpoints: what certificate do they present, would a client with
// verification ON accept it (alone, or once the certificate is explicitly trusted), and what is missing?
//   node scripts/19-tls-check.mjs [pem-out-path]
import tls from "node:tls";
import { writeFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";

const HOSTS = ["ledger-testnet.mahawallet.xyz", "auth-testnet.mahawallet.xyz", "validator-testnet.mahawallet.xyz", "registry-testnet.mahawallet.xyz"];
const connect = (host, opts = {}) => new Promise((resolve) => {
  const s = tls.connect({ host, port: 443, servername: host, ...opts }, () => resolve({ ok: true, socket: s }));
  s.on("error", (e) => resolve({ ok: false, code: e.code ?? e.message }));
  s.setTimeout(10_000, () => { s.destroy(); resolve({ ok: false, code: "TIMEOUT" }); });
});

// 1. what is presented (accept anything just to look at it)
const peek = await connect(HOSTS[0], { rejectUnauthorized: false });
if (!peek.ok) { console.log("cannot connect:", peek.code); process.exit(1); }
const pem = new X509Certificate(peek.socket.getPeerCertificate(true).raw);
peek.socket.destroy();
const days = Math.floor((new Date(pem.validTo) - Date.now()) / 86_400_000);
console.log("certificate presented by the testnet nginx:");
console.log("  subject    :", pem.subject.replace(/\n/g, ", "));
console.log("  issuer     :", pem.issuer.replace(/\n/g, ", "), pem.subject === pem.issuer ? " (SELF-SIGNED)" : "");
console.log("  SAN        :", pem.subjectAltName ?? "(none)");
console.log("  valid      :", pem.validFrom, "->", pem.validTo, `(${days} days left)`);
console.log("  key        :", pem.publicKey.asymmetricKeyType, pem.publicKey.asymmetricKeyDetails?.modulusLength ?? "", " CA:", pem.ca);
console.log("  sha256     :", pem.fingerprint256);
if (process.argv[2]) { writeFileSync(process.argv[2], pem.toString()); console.log("  written to :", process.argv[2]); }

// 2. would a client with verification ON accept it?
console.log("\nverification ON, certificate not trusted:");
for (const h of HOSTS) { const r = await connect(h); console.log(`  ${h.padEnd(36)} ${r.ok ? "ACCEPTED" : "rejected: " + r.code}`); r.socket?.destroy(); }

console.log("\nverification ON, this certificate explicitly trusted (chain + hostname both checked):");
for (const h of HOSTS) { const r = await connect(h, { ca: [pem.toString()] }); console.log(`  ${h.padEnd(36)} ${r.ok ? "ACCEPTED" : "rejected: " + r.code}`); r.socket?.destroy(); }

// 3. does the certificate cover each hostname?
console.log("\nhostname coverage (X509 checkHost):");
for (const h of HOSTS) console.log(`  ${h.padEnd(36)} ${pem.checkHost(h) ? "covered" : "NOT in the certificate"}`);
