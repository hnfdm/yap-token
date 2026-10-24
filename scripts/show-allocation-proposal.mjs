// Prints the content of the open AllocationProposal(s) straight from the ledger, so the members can REVIEW the items before they confirm.
//   node scripts/show-allocation-proposal.mjs      (.env.testnet = t1). DecMan only shows the description, not the items.
import { loadEnv } from "./lib.mjs";
import { node } from "./nodes.mjs";
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const E = loadEnv(".env.testnet"), n = node(E, "t1");
const MEMBER = "cryptolampung-testnet-1::122013397e0d9bb71891e884ccd6948a93057115a2fd46a5cf2e4db254844bbd0ea1";
const ps = await n.acs(MEMBER, "#yap-governance:YapGovernance:AllocationProposal");
console.log("open AllocationProposal contracts:", ps.length);
for (const p of ps) {
  const a = p.createArgument; let tot = 0;
  console.log("purpose:", a.purpose, "| proposer:", a.proposer.split("::")[0], "| treasury inputs:", a.treasuryCids.length);
  for (const [i, it] of a.items.entries()) {
    const v = it.value ?? it; const amt = Number(v.amount); tot += amt;
    const who = (v.receiver ?? v.beneficiary).split("::")[0];
    const days = v.finish ? ((new Date(v.finish) - new Date(v.start)) / 86400000).toFixed(0) : "-";
    const cliff = v.start ? ((new Date(v.start) - Date.now()) / 86400000).toFixed(0) : "-";
    console.log(`${String(i + 1).padStart(2)}. ${(it.tag ?? "").padEnd(11)} ${amt.toLocaleString("en-US", { minimumFractionDigits: 2 }).padStart(18)} YAP  ${who.padEnd(22)}${v.finish ? ` starts in ${cliff}d, vests over ${days}d, revocable=${v.revocable}` : " (free to use at once)"}`);
  }
  console.log("TOTAL", tot.toLocaleString("en-US", { minimumFractionDigits: 2 }), "YAP");
}
