// After uploading a NEW package version (e.g. 0.2.0): archive the old CusdtAdmin and
// CusdtTransferFactory and create fresh ones from the newest vetted version, so their
// interface implementation / choices are the new code. Holdings are left alone.
// Usage: node scripts/8-rotate-singletons.mjs
import { getToken, acs, submit, need, PKG } from "./lib.mjs";

const admin = need("CUSDT_ADMIN_PARTY");
const token = await getToken();
const pkgOf = (templateId) => templateId.split(":")[0];

for (const tpl of ["CusdtAdmin", "CusdtTransferFactory", "CusdtAllocationFactory"]) {
  const name = `${PKG}:CusdtToken:${tpl}`;
  const old = await acs(token, admin, name);
  console.log(`${tpl}: ${old.length} existing, package ids: ${[...new Set(old.map((c) => pkgOf(c.templateId).slice(0, 12)))].join(", ") || "-"}`);
  // Create first, archive after: if creation fails, the old one is still there.
  await submit(token, { actAs: [admin], label: `new-${tpl}`,
    commands: [{ CreateCommand: { templateId: name, createArguments: { admin } } }] });
  const now = await acs(token, admin, name);
  const fresh = now.filter((c) => !old.some((o) => o.contractId === c.contractId));
  console.log(`  created new ${tpl}, package id ${fresh.map((c) => pkgOf(c.templateId).slice(0, 12)).join(", ")}`);
  for (const o of old) {
    await submit(token, { actAs: [admin], label: `archive-${tpl}`,
      commands: [{ ExerciseCommand: { templateId: o.templateId, contractId: o.contractId, choice: "Archive", choiceArgument: {} } }] });
    console.log(`  archived old ${tpl} ${o.contractId.slice(0, 16)}...`);
  }
}
console.log("\nRestart/wait ~30s for the registry's factory cache, then run the tests.");
