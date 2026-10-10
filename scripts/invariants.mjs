// Shared conservation checks for the live-testnet tests (14-invariant-soak, 15-contention-tests).
// Everything is read AS THE ADMIN: it is a signatory of every holding, transfer instruction and allocation.
import { ledger, ledgerEnd, PKG } from "./lib.mjs";

export const T = {
  HOLDING: `${PKG}:CusdtToken:CusdtHolding`, INSTR: `${PKG}:CusdtToken:CusdtTransferInstruction`,
  ALLOC: `${PKG}:CusdtToken:CusdtAllocation`, ADMIN: `${PKG}:CusdtToken:CusdtAdmin`, PRE: `${PKG}:CusdtToken:CusdtTransferPreapproval`,
};
export const mu = (s) => Math.round(Number(s) * 1e6);          // micro-units: exact integer arithmetic
export const sumMu = (cs, f = (c) => c.createArgument.amount) => cs.reduce((s, c) => s + mu(f(c)), 0);
export const isNet = (m) => /fetch failed|ECONN|ETIMEDOUT|UND_ERR|socket|timeout|502|503|504/i.test(m);

/** Reads are safe to retry; writes are not (a timed-out write may still have committed). */
export async function retry(fn, tries = 5) {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) { if (i >= tries || !isNet(String(e.message) + String(e.cause?.code ?? ""))) throw e; await new Promise((r) => setTimeout(r, 3000 * i)); }
  }
}

/** The sequencer can refuse a send while the validator's traffic rate is too high (409 SEQUENCER_REQUEST_FAILED /
 *  RequestRefused / SEQUENCER_BACKPRESSURE). That means the command was NOT sent, so retrying a WRITE is safe. */
export async function retrySend(fn, tries = 8) {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) { if (i >= tries || !/SEQUENCER_REQUEST_FAILED|SEQUENCER_BACKPRESSURE|RequestRefused/.test(String(e.message))) throw e; await new Promise((r) => setTimeout(r, 6000 * i)); }
  }
}

/** Created events of holdings / pending transfer instructions / allocations at one consistent offset. */
export const snapshot = (token, admin) => retry(async () => {
  const off = await ledgerEnd(token);
  const q = async (tpl) => {
    const r = await ledger(token, "/v2/state/active-contracts", { method: "POST", json: { activeAtOffset: off,
      eventFormat: { filtersByParty: { [admin]: { cumulative: [{ identifierFilter: { TemplateFilter: { value: { templateId: tpl, includeCreatedEventBlob: false } } } }] } }, verbose: true } } });
    return (Array.isArray(r) ? r : (r.activeContracts ?? [])).map((it) => it.contractEntry?.JsActiveContract?.createdEvent).filter(Boolean);
  };
  const [H, I, A] = await Promise.all([q(T.HOLDING), q(T.INSTR), q(T.ALLOC)]);
  return { H, I, A };
});

/** Supply as the ledger sees it: holdings (locked included) + amounts sitting in pending instructions. */
export const supply = (S) => sumMu(S.H) + sumMu(S.I, (c) => c.createArgument.transfer.amount);

/** Returns a list of violated invariants (empty = all hold).
 *  I1 supply == expected   I2 locked == active allocation legs   I3/I4 allocation <-> locked holding 1:1   I5 amounts > 0, <= 6 decimals */
export function checkInvariants(S, expected) {
  const v = [];
  const sumH = sumMu(S.H), sumI = sumMu(S.I, (c) => c.createArgument.transfer.amount);
  if (sumH + sumI !== expected) v.push(`I1 supply: holdings ${sumH} + pending ${sumI} = ${sumH + sumI} != expected ${expected} (micro)`);
  const locked = S.H.filter((h) => h.createArgument.lock != null);
  const allocSum = sumMu(S.A, (c) => c.createArgument.allocation.transferLeg.amount);
  if (sumMu(locked) !== allocSum) v.push(`I2 locked ${sumMu(locked)} != allocations ${allocSum}`);
  const byCid = new Map(S.H.map((h) => [h.contractId, h]));
  const refs = new Map();
  for (const a of S.A) {
    const h = byCid.get(a.createArgument.lockedCid);
    if (!h) v.push(`I3 allocation ${a.contractId.slice(0, 10)} has no holding`);
    else if (h.createArgument.lock == null || mu(h.createArgument.amount) !== mu(a.createArgument.allocation.transferLeg.amount)) v.push(`I3 allocation ${a.contractId.slice(0, 10)} holding mismatch`);
    refs.set(a.createArgument.lockedCid, (refs.get(a.createArgument.lockedCid) ?? 0) + 1);
  }
  for (const h of locked) if ((refs.get(h.contractId) ?? 0) !== 1) v.push(`I4 locked holding ${h.contractId.slice(0, 10)} referenced ${refs.get(h.contractId) ?? 0}x`);
  for (const h of S.H) { const x = Number(h.createArgument.amount); if (!(x > 0) || Math.abs(x * 1e6 - Math.round(x * 1e6)) > 1e-6) v.push(`I5 bad amount ${h.createArgument.amount}`); }
  return v;
}
