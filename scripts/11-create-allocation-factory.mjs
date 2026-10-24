// Create the YapAllocationFactory singleton (v0.3.0+). Idempotent.
import { getToken, acs, submit, need, PKG } from "./lib.mjs";

const admin = need("CUSDT_ADMIN_PARTY");
const token = await getToken();
const templateId = `${PKG}:YapToken:YapAllocationFactory`;

const existing = await acs(token, admin, templateId);
if (existing.length) {
  console.log("already exists:", existing.map((c) => c.contractId.slice(0, 16) + "... (pkg " + c.templateId.split(":")[0].slice(0, 12) + ")").join(", "));
  process.exit(0);
}
await submit(token, { actAs: [admin], label: "alloc-factory",
  commands: [{ CreateCommand: { templateId, createArguments: { admin } } }] });
const [c] = await acs(token, admin, templateId);
console.log("created YapAllocationFactory, pkg", c.templateId.split(":")[0].slice(0, 12));
