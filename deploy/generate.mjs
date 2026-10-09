// Builds the paste-able VPS scripts into deploy/out/ from deploy/templates/*.in and the real sources,
// so the code embedded in them can never drift from the repo.   node deploy/generate.mjs
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const yaml = read("daml/cusdt-token/daml.yaml");
const version = yaml.match(/^version:\s*(\S+)/m)?.[1];
const sdk = yaml.match(/^sdk-version:\s*(\S+)/m)?.[1];
if (!version || !sdk) throw new Error("cannot read version / sdk-version from daml.yaml");

let admin = process.env.CUSDT_ADMIN_PARTY;
if (!admin) { try { admin = read(".env.testnet").match(/^CUSDT_ADMIN_PARTY=(\S+)/m)?.[1]; } catch { /* no env file */ } }
if (!admin) admin = "CHANGE_ME_CUSDT_ADMIN_PARTY";

const out = join(root, "deploy", "out");
mkdirSync(out, { recursive: true });
for (const t of readdirSync(join(root, "deploy", "templates")).filter((f) => f.endsWith(".in"))) {
  let text = read(`deploy/templates/${t}`);
  text = text.replace(/^@@EMBED (.+)@@$/gm, (_, file) => read(file).replace(/\n$/, ""));
  text = text.replaceAll("@@VERSION@@", version).replaceAll("@@SDK@@", sdk).replaceAll("@@ADMIN@@", admin);
  const dst = join(out, t.replace(/\.in$/, ""));
  writeFileSync(dst, text);
  execFileSync("bash", ["-n", dst]);   // syntax check
  console.log(`ok  deploy/out/${t.replace(/\.in$/, "")}  (v${version}, sdk ${sdk})`);
}
if (admin.startsWith("CHANGE_ME")) console.log("warning: CUSDT_ADMIN_PARTY not found; install-registry-on-vps.sh has a placeholder");
