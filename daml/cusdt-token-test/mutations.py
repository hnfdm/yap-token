#!/usr/bin/env python3
# Mutation test for the cUSDT contract: break ONE rule at a time, rebuild, run the Daml Script tests and see whether some test notices.
#   python3 mutations.py <workdir>      workdir contains cusdt-token/ and cusdt-token-test/ (both as in the repo)
# A mutation is "killed" when at least one test fails (or the build breaks: invalid mutation). It SURVIVES when every test still passes:
# either that rule has no test (a gap) or the mutation is behaviour-neutral.
import os, re, subprocess, sys

W = sys.argv[1]
SRC = os.path.join(W, "cusdt-token", "daml", "CusdtToken.daml")
C, T = os.path.join(W, "cusdt-token"), os.path.join(W, "cusdt-token-test")
ORIG = open(SRC).read()

# (name, old text, new text, nth occurrence of `old` (1-based))
M = [
 ("precision rule", '(roundBankers 6 x == x)', 'True', 1),
 ("spend: input admin", '(h.admin == admin)', 'True', 1),
 ("spend: input owner", '(h.owner == sender)', 'True', 1),
 ("spend: input locked", '(h.lock == None)', 'True', 1),
 ("spend: insufficient funds", '(total >= amount)', 'True', 1),
 ("spend: change +1", 'let change = total - amount', 'let change = total - amount + 1.0', 1),
 ("release: amount +1", 'amount = locked.amount, lock = None', 'amount = locked.amount + 1.0, lock = None', 1),
 ("execute: receiver paid +1", 'amount = locked.amount, lock = None', 'amount = locked.amount + 1.0, lock = None', 2),
 ("split: locked", 'assertMsg "holding is locked" (lock == None)', 'assertMsg "holding is locked" True', 1),
 ("merge: locked", 'assertMsg "holding is locked" (lock == None)', 'assertMsg "holding is locked" True', 2),
 ("burn: locked", 'assertMsg "holding is locked" (lock == None)', 'assertMsg "holding is locked" True', 3),
 ("split: positive", '(splitAmount > 0.0)', 'True', 1),
 ("split: less than amount", '(splitAmount < amount)', 'True', 1),
 ("split: precision", 'assertPrecision "splitAmount" splitAmount', 'pure ()', 1),
 ("merge: owner mismatch", '(o.owner == owner)', 'True', 1),
 ("merge: admin mismatch", '(o.admin == admin)', 'True', 1),
 ("merge: other locked", '(o.lock == None)', 'True', 1),
 ("mint: precision", 'assertPrecision "mint amount" amount', 'pure ()', 1),
 ("holding: ensure amount > 0", 'ensure amount > 0.0', 'ensure True', 1),
 ("transfer: expectedAdmin", '(arg.expectedAdmin == admin)', 'True', 2),
 ("transfer: instrument", '(t.instrumentId == cusdtInstrumentId admin)', 'True', 1),
 ("transfer: amount positive", '(t.amount > 0.0)', 'True', 1),
 ("transfer: precision", 'assertPrecision "amount" t.amount', 'pure ()', 1),
 ("transfer: inputs required", '(not (null t.inputHoldingCids))', 'True', 1),
 ("transfer: requestedAt in the past", '(t.requestedAt <= now)', 'True', 1),
 ("transfer: executeBefore in the future", '(t.executeBefore > now)', 'True', 1),
 ("preapproval: admin", '(p.admin == admin)', 'True', 1),
 ("preapproval: receiver", '(p.receiver == t.receiver)', 'True', 1),
 ("accept: expiry", '(now < transfer.executeBefore)', 'True', 1),
 ("reject: refund to receiver (wrong)", 'transferInstruction_rejectImpl _self _arg = do\n        h <- create CusdtHolding with\n          admin, owner = transfer.sender', 'transferInstruction_rejectImpl _self _arg = do\n        h <- create CusdtHolding with\n          admin, owner = transfer.receiver', 1),
 ("withdraw: refund to receiver (wrong)", 'transferInstruction_withdrawImpl _self _arg = do\n        h <- create CusdtHolding with\n          admin, owner = transfer.sender', 'transferInstruction_withdrawImpl _self _arg = do\n        h <- create CusdtHolding with\n          admin, owner = transfer.receiver', 1),
 ("allocate: expectedAdmin", '(arg.expectedAdmin == admin)', 'True', 4),
 ("allocate: instrument", '(leg.instrumentId == cusdtInstrumentId admin)', 'True', 1),
 ("allocate: amount positive", '(leg.amount > 0.0)', 'True', 1),
 ("allocate: precision", 'assertPrecision "amount" leg.amount', 'pure ()', 1),
 ("allocate: inputs required", '(not (null arg.inputHoldingCids))', 'True', 1),
 ("allocate: requestedAt in the past", '(arg.requestedAt <= now)', 'True', 1),
 ("allocate: allocateBefore in the future", '(settlement.allocateBefore > now)', 'True', 1),
 ("allocate: settleBefore after allocateBefore", '(settlement.settleBefore > settlement.allocateBefore)', 'True', 1),
 ("execute: settleBefore window", '(now < allocation.settlement.settleBefore)', 'True', 1),
 ("proposal: sender /= receiver", 'ensure sender /= receiver', 'ensure True', 1),
 ("proposal: expiry on accept", '(now < expiresAt)', 'True', 1),
 ("revoke by receiver needs sender too", 'choice CusdtSettlement_RevokeByReceiver : ()\n      controller receiver', 'choice CusdtSettlement_RevokeByReceiver : ()\n      controller receiver, sender', 1),
 ("revoke by sender needs receiver too", 'choice CusdtSettlement_RevokeBySender : ()\n      controller sender', 'choice CusdtSettlement_RevokeBySender : ()\n      controller sender, receiver', 1),
 ("delegation: expiry", '(now < d.expiresAt)', 'True', 1),
 ("delegation: executor", '(v.allocation.settlement.executor == d.executor)', 'True', 1),
 ("delegation: sender", '(v.allocation.transferLeg.sender == d.sender)', 'True', 1),
 ("delegation: receiver", '(v.allocation.transferLeg.receiver == d.receiver)', 'True', 1),
 ("delegation: settlement ref", '(v.allocation.settlement.settlementRef.id == d.settlementRefId)', 'True', 1),
 ("Execute needs sender too", 'controller executor', 'controller executor, sender', 1),
 ("burnmint: publicFetch expectedAdmin", '(arg.expectedAdmin == admin)', 'True', 5),
 ("burnmint: expectedAdmin", '(arg.expectedAdmin == admin)', 'True', 6),
 ("burnmint: instrument", '(arg.instrumentId == cusdtInstrumentId admin)', 'True', 1),
 ("burnmint: something to do", '(not (null arg.inputHoldingCids && null arg.outputs))', 'True', 1),
 ("burnmint: input admin", '(h.admin == admin)', 'True', 2),
 ("burnmint: input locked", '(h.lock == None)', 'True', 2),
 ("burnmint: owner consent", '(h.owner `elem` arg.extraActors)', 'True', 1),
 ("burnmint: output positive", '(o.amount > 0.0)', 'True', 1),
 ("burnmint: output precision", 'assertPrecision "output amount" o.amount', 'pure ()', 1),
 ("Cancel needs sender too", 'controller executor', 'controller executor, sender', 2),
]

def nth_replace(s, old, new, n):
    i = -1
    for _ in range(n):
        i = s.find(old, i + 1)
        if i < 0: return None
    return s[:i] + new + s[i + len(old):]

def run(cmd, cwd):
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    return p.returncode, (p.stdout or "") + (p.stderr or "")

def tests_failed(out):
    names = []
    for line in out.splitlines():
        m = re.match(r"^daml/\S+:(\w+): (.*)$", line.strip())
        if m and not m.group(2).startswith("ok"): names.append(m.group(1))
    return names

results = []
try:
    # baseline: the unmutated contract must pass everything, otherwise nothing below means anything
    rc, out = run(["dpm", "build"], C)
    if rc != 0: print("BASELINE BUILD FAILED\n" + out[-1500:]); sys.exit(2)
    run(["dpm", "build"], T); rc, out = run(["dpm", "test"], T)
    base_fail = tests_failed(out)
    print(f"baseline: {'all tests pass' if not base_fail else 'FAILING: ' + ', '.join(base_fail)}", flush=True)
    if base_fail: sys.exit(2)
    for k, (name, old, new, nth) in enumerate(M, 1):
        mutated = nth_replace(ORIG, old, new, nth)
        if mutated is None:
            results.append((name, "NO MATCH", "")); print(f"[{k}/{len(M)}] {name}: NO MATCH (text not found, occurrence {nth})", flush=True); continue
        open(SRC, "w").write(mutated)
        rc, out = run(["dpm", "build"], C)
        if rc != 0:
            results.append((name, "BUILD ERROR", "")); print(f"[{k}/{len(M)}] {name}: build error (invalid mutation)", flush=True); continue
        rc, out = run(["dpm", "build"], T)
        if rc != 0:
            results.append((name, "TEST BUILD ERROR", "")); print(f"[{k}/{len(M)}] {name}: tests no longer compile", flush=True); continue
        rc, out = run(["dpm", "test"], T)
        failed = tests_failed(out)
        status = "KILLED" if failed else "SURVIVED"
        results.append((name, status, ", ".join(failed)))
        print(f"[{k}/{len(M)}] {name}: {status}{' by ' + ', '.join(failed[:3]) + (' …' if len(failed) > 3 else '') if failed else ''}", flush=True)
finally:
    open(SRC, "w").write(ORIG)

killed = [r for r in results if r[1] == "KILLED"]
surv = [r for r in results if r[1] == "SURVIVED"]
other = [r for r in results if r[1] not in ("KILLED", "SURVIVED")]
print(f"\n== {len(killed)} killed, {len(surv)} SURVIVED, {len(other)} not evaluated ({len(M)} mutations) ==")
if surv:
    print("\nSURVIVORS (no test notices when this rule is removed):")
    for n, _, _ in surv: print("  -", n)
if other:
    print("\nNOT EVALUATED:")
    for n, s, _ in other: print(f"  - {n}: {s}")
