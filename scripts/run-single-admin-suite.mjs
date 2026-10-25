// Re-runs the live scripts that need a SINGLE-OWNER admin against a FRESH yap-token deployment on t1, and prints a summary table.
//   node scripts/run-single-admin-suite.mjs                  setup + the default list
//   node scripts/run-single-admin-suite.mjs --only 6,7,10    only these scripts (setup is skipped when .env.sa already has an admin)
//   node scripts/run-single-admin-suite.mjs --heavy          also the scripts that create 200+ contracts (16, 32, 33)
//
// What it does:  .env.sa (git-ignored) = .env.testnet without CUSDT_ADMIN_PARTY  ->  2-setup creates the admin party "yap-sa-admin" and its
// singletons  ->  11 creates the allocation factory  ->  3-mint gives alice and bob 1000 YAP  ->  a LOCAL registry on port 18787 serves that
// admin  ->  every script runs in turn (own process, own log in .sa-logs/) and is judged by its "N passed, M failed" line or its exit code.
// It does NOT touch the governed YAP instance (a different admin party and different contracts).
// Not runnable on one node (they need the MZF / cryptolampung / second nodes): 20, 21, 22, 24, 25, 27, 30, 34.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getToken, ledger } from "./lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : null;
const heavy = args.includes("--heavy");
const twoNode = args.includes("--two-node");
const logDir = join(root, ".sa-logs"); mkdirSync(logDir, { recursive: true });

const DEFAULT = ["4-e2e-test", "6-negative-tests", "7-disclosure-tests", "10-preapproval-tests", "12-allocation-tests", "13-precision-tests",
  "14-invariant-soak", "15-contention-tests", "17-edge-cases", "18-registry-resilience", "26-registry-fuzz", "28-stale-factory-window",
  "29-pending-spam", "31-ws-active-contracts", "35-live-burnmint-v2", "36-live-lock-vesting", "37-live-operator", "38-live-operator-registry", "39-live-operator-contention"];
const HEAVY = ["16-preapproval-cap-test", "32-ws-beats-the-cap", "33-pending-spam-205"];
// need a SECOND participant: its settings go into .env.t2 (git-ignored, see deploy/templates/print-env-block-on-vps.sh.in)
const TWO = ["21-cross-participant", "22-delegated-settlement", "24-cross-node-race"];
const list = (only ?? (twoNode ? TWO : [...DEFAULT, ...(heavy ? HEAVY : [])])).map((x) => [...DEFAULT, ...HEAVY, ...TWO].find((f) => f === x || f.startsWith(x + "-")) ?? x);

// scripts that take arguments
const ARGS = { "4-e2e-test": (e) => [e.CUSDT_ALICE, e.CUSDT_BOB, "1"] };
// prerequisites that must hold only for ONE script (10 needs bob to HAVE a preapproval, 6 needs him not to have one)
const PRE = { "10-preapproval-tests": [["9-preapprove", (e) => [e.CUSDT_BOB]]] };

const read = (f) => readFileSync(join(root, f), "utf8").split(/\r?\n/);
const SA = ".env.sa";
if (!existsSync(join(root, SA))) {
  const lines = read(".env.testnet").filter((l) => !/^\s*CUSDT_ADMIN_PARTY\s*=/.test(l));
  lines.push("CUSDT_ADMIN_HINT=yap-sa-admin");
  writeFileSync(join(root, SA), lines.join("\n") + "\n");
  console.log(`wrote ${SA} from .env.testnet (without the admin party)`);
}
const envOf = () => Object.fromEntries(read(SA).map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean).map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]));

const run = (file, extra = [], envExtra = {}, timeoutMs = 25 * 60_000) => new Promise((resolve) => {
  const e = envOf();
  const child = spawn(process.execPath, [join(root, "scripts", file + ".mjs"), ...extra], {
    cwd: root, env: { ...process.env, CUSDT_ENV_FILE: SA, ...(e.CUSDT_ADMIN_PARTY ? { CUSDT_ADMIN_PARTY: e.CUSDT_ADMIN_PARTY } : {}), ...(e.CUSDT_ALICE ? { CUSDT_ALICE: e.CUSDT_ALICE, CUSDT_BOB: e.CUSDT_BOB } : {}), NODE_TLS_REJECT_UNAUTHORIZED: "0", ...envExtra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = ""; const t0 = Date.now();
  child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
  const timer = setTimeout(() => { out += "\n[TIMEOUT]"; child.kill(); }, timeoutMs);
  child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, secs: Math.round((Date.now() - t0) / 1000) }); });
});
const clean = (s) => s.split("\n").filter((l) => !/Warning:|trace-warnings/i.test(l)).join("\n");

// ---------- setup ----------
let env = envOf();
if (!env.CUSDT_ADMIN_PARTY) {
  console.log("== setup: admin party + singletons ==");
  const r = await run("2-setup");
  const m = r.out.match(/CUSDT_ADMIN_PARTY =\s*(\S+)/);
  if (!m || r.code !== 0) { console.log(clean(r.out)); throw new Error("2-setup failed"); }
  appendFileSync(join(root, SA), `\nCUSDT_ADMIN_PARTY=${m[1]}\n`);
  console.log("admin:", m[1]);
  for (const [f, a] of [["11-create-allocation-factory", []], ["3-mint", [env.CUSDT_ALICE, "1000"]], ["3-mint", [env.CUSDT_BOB, "1000"]]]) {
    const x = await run(f, a);
    console.log(`${f} ${a.length ? a[1] : ""}: exit ${x.code} ${clean(x.out).trim().split("\n").slice(-1)[0]}`);
    if (x.code !== 0) throw new Error(`${f} failed:\n${clean(x.out)}`);
  }
  env = envOf();
}

// clean test parties: alice and bob of the governed YAP instance also hold governed YAP, which these scripts must not mix with
if (!env.CUSDT_ALICE?.startsWith("yap-sa-")) {
  console.log("== setup: clean test parties yap-sa-alice / yap-sa-bob ==");
  const token = await getToken();
  const existing = (await ledger(token, "/v2/parties")).partyDetails ?? [];
  const lines = read(SA).filter((l) => !/^\s*CUSDT_(ALICE|BOB)\s*=/.test(l));
  for (const [key, hint] of [["CUSDT_ALICE", "yap-sa-alice"], ["CUSDT_BOB", "yap-sa-bob"]]) {
    let party = existing.find((p) => p.party.startsWith(hint + "::"))?.party;
    if (!party) party = (await ledger(token, "/v2/parties", { method: "POST", json: { partyIdHint: hint, identityProviderId: "" } })).partyDetails.party;
    await ledger(token, `/v2/users/${encodeURIComponent(env.LEDGER_USER_ID)}/rights`, { method: "POST", json: { userId: env.LEDGER_USER_ID, identityProviderId: "",
      rights: [{ kind: { CanActAs: { value: { party } } } }, { kind: { CanReadAs: { value: { party } } } }] } });
    lines.push(`${key}=${party}`);
  }
  writeFileSync(join(root, SA), lines.join("\n") + "\n");
  env = envOf();
  for (const [f, a] of [["3-mint", [env.CUSDT_ALICE, "1000"]], ["3-mint", [env.CUSDT_BOB, "1000"]]]) {
    const x = await run(f, a);
    console.log(`${f} ${a[1] ?? ""}: exit ${x.code} ${clean(x.out).trim().split("\n").slice(-1)[0]}`);
    if (x.code !== 0) throw new Error(`${f} failed:\n${clean(x.out)}`);
  }
}
console.log("admin of this suite:", env.CUSDT_ADMIN_PARTY, "| alice:", env.CUSDT_ALICE.split("::")[0], "| bob:", env.CUSDT_BOB.split("::")[0]);

// ---------- second node (only for 21, 22, 24) ----------
const needsSecond = list.some((f) => TWO.includes(f));
const T2 = ".env.t2";
const t2Extra = {};
if (needsSecond) {
  if (!existsSync(join(root, T2))) throw new Error(`${T2} is missing: run deploy/out/print-env-block-on-vps.sh on the second node and paste its block into ${T2}`);
  const t2Env = () => Object.fromEntries(read(T2).map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean).map((m) => [m[1], m[2]]));
  if (!t2Env().CUSDT_MZF_CAROL) {
    console.log("== setup: receiver party yap-sa-carol on the second node ==");
    const x = await run("20-mzf-setup", [], { CUSDT_ENV_FILE: T2, CUSDT_SETUP_HINT: "yap-sa-carol", CUSDT_SETUP_KEY: "CUSDT_MZF_CAROL" });
    console.log(clean(x.out).trim().split("\n").slice(-3).join("\n"));
    if (x.code !== 0) throw new Error("20-mzf-setup failed on the second node");
  }
  t2Extra.CUSDT_MZF_ENV = T2;
}

// ---------- local registry for that admin ----------
const RPORT = 18787;
const reg = spawn(process.execPath, [join(root, "registry", "src", "server.mjs")], { cwd: root, stdio: ["ignore", "ignore", "inherit"],
  env: { ...process.env, HOST: "127.0.0.1", PORT: String(RPORT), LEDGER_URL: env.LEDGER_URL, KC_TOKEN_URL: env.KC_TOKEN_URL, KC_CLIENT_ID: env.KC_CLIENT_ID, KC_CLIENT_SECRET: env.KC_CLIENT_SECRET,
    KC_SCOPE: env.KC_SCOPE ?? "daml_ledger_api", CUSDT_ADMIN_PARTY: env.CUSDT_ADMIN_PARTY, CUSDT_ENABLE_V2: "1", CUSDT_ENABLE_ALLOCATION_V2: "1", NODE_TLS_REJECT_UNAUTHORIZED: "0" } });
await new Promise((r) => setTimeout(r, 1500));
const regUrl = `http://127.0.0.1:${RPORT}`;

// ---------- the scripts ----------
const rows = [];
try {
  for (const f of list) {
    for (const [pf, pa] of PRE[f] ?? []) { const x = await run(pf, pa(env)); if (x.code !== 0) throw new Error(`${pf} failed:
${clean(x.out)}`); }
    process.stdout.write(`running ${f.padEnd(34)} `);
    const r = await run(f, ARGS[f] ? ARGS[f](env) : [], { CUSDT_REGISTRY_URL: regUrl, ...(TWO.includes(f) ? t2Extra : {}) });
    const text = clean(r.out);
    writeFileSync(join(logDir, f + ".log"), text);
    const m = [...text.matchAll(/(\d+)\s+passed,\s+(\d+)\s+failed/g)].pop();
    const fails = (text.match(/^FAIL\b/gm) ?? []).length;
    const verdict = r.out.includes("[TIMEOUT]") ? "TIMEOUT" : m ? (Number(m[2]) === 0 && r.code === 0 ? "PASS" : "FAIL") : r.code === 0 && fails === 0 ? "PASS (exit 0)" : "FAIL";
    rows.push({ f, verdict, counts: m ? `${m[1]} / ${Number(m[1]) + Number(m[2])}` : `exit ${r.code}`, secs: r.secs, fails });
    console.log(`${verdict.padEnd(14)} ${rows.at(-1).counts.padEnd(10)} ${r.secs}s`);
  }
} finally { reg.kill(); }

console.log("\n== summary ==");
for (const r of rows) console.log(`${r.verdict.padEnd(14)} ${r.f.padEnd(34)} ${r.counts.padEnd(12)} ${r.secs}s${r.fails ? `  (${r.fails} FAIL lines, see .sa-logs/${r.f}.log)` : ""}`);
const bad = rows.filter((r) => !r.verdict.startsWith("PASS"));
console.log(`\n${rows.length - bad.length} of ${rows.length} scripts passed${bad.length ? `; to look at: ${bad.map((b) => b.f).join(", ")}` : ""}`);
process.exitCode = bad.length ? 1 : 0;
