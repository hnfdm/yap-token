// Command builders shared by the live-testnet test scripts. Each returns a THUNK so callers can run them
// one by one, or start several together (races).   const ops = makeOps({ token, admin, registry });
import { submit } from "./lib.mjs";
import { retry } from "./invariants.mjs";

export const IF = {
  TF: "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory",
  TI: "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction",
  AF: "#splice-api-token-allocation-instruction-v1:Splice.Api.Token.AllocationInstructionV1:AllocationFactory",
  A: "#splice-api-token-allocation-v1:Splice.Api.Token.AllocationV1:Allocation",
};
export const iso = (ms) => new Date(Date.now() + ms).toISOString();
export const amt = (m) => (m / 1e6).toFixed(10);
const extra = { extraArgs: { context: { values: {} }, meta: { values: {} } } };

export function makeOps({ token, admin, registry }) {
  const post = (path, body) => retry(async () => {
    const r = await fetch(`${registry}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`registry ${r.status}`); return r.json();
  });
  const inst = { admin, id: "YAP" };
  /** transfer; `amount` is a decimal STRING (so malformed values can be tested); overrides patch the transfer record */
  const transfer = (sender, receiver, amount, inputs, o = {}) => async () => {
    const t = { sender, receiver, amount, instrumentId: inst, requestedAt: iso(-30_000), executeBefore: iso(3_600_000), inputHoldingCids: inputs.map((h) => h.contractId ?? h), meta: { values: {} }, ...(o.patch ?? {}) };
    const f = await post("/registry/transfer-instruction/v1/transfer-factory", { choiceArguments: { expectedAdmin: admin, transfer: { ...t, instrumentId: inst } } });
    return submit(token, { actAs: o.actAs ?? [sender], label: "ops-t", disclosedContracts: f.choiceContext.disclosedContracts,
      commands: [{ ExerciseCommand: { templateId: IF.TF, contractId: f.factoryId, choice: "TransferFactory_Transfer",
        choiceArgument: { expectedAdmin: admin, transfer: t, extraArgs: { context: f.choiceContext.choiceContextData, meta: { values: {} } } } } }] });
  };
  const allocate = (sender, receiver, amount, inputs, ref, o = {}) => async () => {
    const spec = { settlement: { executor: o.executor ?? admin, settlementRef: { id: ref, cid: null }, requestedAt: iso(-30_000), allocateBefore: iso(3_600_000), settleBefore: iso(7_200_000), meta: { values: {} } },
      transferLegId: "leg-1", transferLeg: { sender, receiver, amount, instrumentId: inst, meta: { values: {} } } };
    const args = { expectedAdmin: admin, allocation: spec, requestedAt: iso(-30_000), inputHoldingCids: inputs.map((h) => h.contractId ?? h) };
    const f = await post("/registry/allocation-instruction/v1/allocation-factory", { choiceArguments: { ...args, allocation: { ...spec, transferLeg: { ...spec.transferLeg, instrumentId: inst } } } });
    return submit(token, { actAs: o.actAs ?? [sender], label: "ops-a", disclosedContracts: f.choiceContext.disclosedContracts,
      commands: [{ ExerciseCommand: { templateId: IF.AF, contractId: f.factoryId, choice: "AllocationFactory_Allocate",
        choiceArgument: { ...args, extraArgs: { context: f.choiceContext.choiceContextData, meta: { values: {} } } } } }] });
  };
  const ti = (actAs, cid, choice) => () => submit(token, { actAs: [actAs], label: "ops-ti", commands: [{ ExerciseCommand: { templateId: IF.TI, contractId: cid, choice, choiceArgument: extra } }] });
  const al = (actAs, cid, choice) => () => submit(token, { actAs, label: "ops-al", commands: [{ ExerciseCommand: { templateId: IF.A, contractId: cid, choice, choiceArgument: extra } }] });
  const tpl = (actAs, templateId, cid, choice, args = {}) => () => submit(token, { actAs, label: "ops-x", commands: [{ ExerciseCommand: { templateId, contractId: cid, choice, choiceArgument: args } }] });
  return { transfer, allocate, ti, al, tpl, post };
}
