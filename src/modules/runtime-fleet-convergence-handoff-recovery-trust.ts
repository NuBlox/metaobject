import { ConcurrencyError, MetadataError } from "../errors/errors.js";
import type {
  RuntimeFleetHandoffRecoveryEvidenceSignatureRecord,
  RuntimeFleetHandoffRecoveryEvidenceSignatureVerification,
} from "./runtime-fleet-convergence-handoff-recovery-signature.js";
import { validateRuntimeFleetHandoffRecoveryEvidenceSignatureRecord } from "./runtime-fleet-convergence-handoff-recovery-signature.js";

export interface RuntimeFleetHandoffRecoveryEvidenceTrustSignerRequirement {
  readonly signerId: string;
  readonly required?: boolean;
  readonly allowedAlgorithms?: readonly string[];
  readonly allowedKeyIds?: readonly string[];
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyDefinition {
  readonly policyId: string;
  readonly version: number;
  readonly minimumValidSignatures: number;
  readonly signers: readonly RuntimeFleetHandoffRecoveryEvidenceTrustSignerRequirement[];
}

export type RuntimeFleetHandoffRecoveryEvidenceTrustDecision = "trusted" | "untrusted";

export interface RuntimeFleetHandoffRecoveryEvidenceTrustSignatureDecision {
  readonly signatureId: string;
  readonly signerId: string;
  readonly algorithm: string;
  readonly keyId: string;
  readonly valid: boolean;
  readonly accepted: boolean;
  readonly reason: string;
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustEvaluationRecord {
  readonly format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust";
  readonly formatVersion: 1;
  readonly evaluationId: string;
  readonly integrityId: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly decision: RuntimeFleetHandoffRecoveryEvidenceTrustDecision;
  readonly minimumValidSignatures: number;
  readonly validSignerIds: readonly string[];
  readonly missingRequiredSignerIds: readonly string[];
  readonly signatures: readonly RuntimeFleetHandoffRecoveryEvidenceTrustSignatureDecision[];
  readonly evaluatedAt: string;
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustEvaluationFilter {
  readonly integrityId?: string;
  readonly policyId?: string;
  readonly decision?: RuntimeFleetHandoffRecoveryEvidenceTrustDecision;
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustEvaluationStore {
  get(evaluationId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustEvaluationRecord | null>;
  list(
    filter?: RuntimeFleetHandoffRecoveryEvidenceTrustEvaluationFilter,
  ): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceTrustEvaluationRecord[]>;
  create(
    record: RuntimeFleetHandoffRecoveryEvidenceTrustEvaluationRecord,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustEvaluationRecord>;
}

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryRuntimeFleetHandoffRecoveryEvidenceTrustEvaluationStore
implements RuntimeFleetHandoffRecoveryEvidenceTrustEvaluationStore {
  readonly #records = new Map<string, RuntimeFleetHandoffRecoveryEvidenceTrustEvaluationRecord>();

  async get(evaluationId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustEvaluationRecord | null> {
    const record = this.#records.get(evaluationId);
    return record ? clone(record) : null;
  }

  async list(
    filter: RuntimeFleetHandoffRecoveryEvidenceTrustEvaluationFilter = {},
  ): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceTrustEvaluationRecord[]> {
    return [...this.#records.values()]
      .filter((record) => filter.integrityId === undefined || record.integrityId === filter.integrityId)
      .filter((record) => filter.policyId === undefined || record.policyId === filter.policyId)
      .filter((record) => filter.decision === undefined || record.decision === filter.decision)
      .sort((left, right) => left.evaluatedAt.localeCompare(right.evaluatedAt) || left.evaluationId.localeCompare(right.evaluationId))
      .map(clone);
  }

  async create(
    record: RuntimeFleetHandoffRecoveryEvidenceTrustEvaluationRecord,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustEvaluationRecord> {
    validateRuntimeFleetHandoffRecoveryEvidenceTrustEvaluationRecord(record);
    if (this.#records.has(record.evaluationId)) {
      throw new ConcurrencyError(`Runtime fleet handoff recovery evidence trust evaluation '${record.evaluationId}' already exists.`);
    }
    const stored = clone(record);
    this.#records.set(stored.evaluationId, stored);
    return clone(stored);
  }
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustSignatureSource {
  history(filter: { readonly integrityId?: string }): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceSignatureRecord[]>;
  verify(signatureId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceSignatureVerification>;
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustRequest {
  readonly evaluationId: string;
  readonly integrityId: string;
  readonly policy: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyDefinition;
}

export type RuntimeFleetHandoffRecoveryEvidenceTrustClock = () => Date;

/**
 * Evaluate immutable M50 signature envelopes against one versioned trust policy.
 * Distinct signer IDs count once toward quorum. Verification/provider failures
 * fail closed and are recorded as rejected signature decisions.
 */
export class RuntimeFleetHandoffRecoveryEvidenceTrustCatalog {
  constructor(
    private readonly signatures: RuntimeFleetHandoffRecoveryEvidenceTrustSignatureSource,
    private readonly evaluations: RuntimeFleetHandoffRecoveryEvidenceTrustEvaluationStore,
    private readonly clock: RuntimeFleetHandoffRecoveryEvidenceTrustClock = () => new Date(),
  ) {}

  async evaluate(
    request: RuntimeFleetHandoffRecoveryEvidenceTrustRequest,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustEvaluationRecord> {
    assertText(request.evaluationId, "evaluationId");
    assertText(request.integrityId, "integrityId");
    validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicy(request.policy);
    if (await this.evaluations.get(request.evaluationId)) {
      throw new ConcurrencyError(`Runtime fleet handoff recovery evidence trust evaluation '${request.evaluationId}' already exists.`);
    }

    const requirements = new Map(request.policy.signers.map((item) => [item.signerId, item] as const));
    const records = [...await this.signatures.history({ integrityId: request.integrityId })]
      .sort((left, right) => left.signerId.localeCompare(right.signerId) || left.signatureId.localeCompare(right.signatureId));

    const decisions: RuntimeFleetHandoffRecoveryEvidenceTrustSignatureDecision[] = [];
    const acceptedBySigner = new Map<string, RuntimeFleetHandoffRecoveryEvidenceTrustSignatureDecision>();

    for (const record of records) {
      validateRuntimeFleetHandoffRecoveryEvidenceSignatureRecord(record);
      const requirement = requirements.get(record.signerId);
      if (!requirement) {
        decisions.push(decision(record, false, false, "signer is not allowed by policy"));
        continue;
      }
      if (requirement.allowedAlgorithms && !requirement.allowedAlgorithms.includes(record.algorithm)) {
        decisions.push(decision(record, false, false, "signature algorithm is not allowed by policy"));
        continue;
      }
      if (requirement.allowedKeyIds && !requirement.allowedKeyIds.includes(record.keyId)) {
        decisions.push(decision(record, false, false, "signature key is not allowed by policy"));
        continue;
      }

      let verification: RuntimeFleetHandoffRecoveryEvidenceSignatureVerification;
      try {
        verification = await this.signatures.verify(record.signatureId);
      } catch {
        decisions.push(decision(record, false, false, "signature verification failed closed"));
        continue;
      }
      if (!verification.valid) {
        decisions.push(decision(record, false, false, "signature verification is invalid"));
        continue;
      }
      if (acceptedBySigner.has(record.signerId)) {
        decisions.push(decision(record, true, false, "signer already contributed one valid signature"));
        continue;
      }
      const accepted = decision(record, true, true, "valid signature accepted");
      acceptedBySigner.set(record.signerId, accepted);
      decisions.push(accepted);
    }

    const validSignerIds = [...acceptedBySigner.keys()].sort();
    const missingRequiredSignerIds = request.policy.signers
      .filter((item) => item.required === true && !acceptedBySigner.has(item.signerId))
      .map((item) => item.signerId)
      .sort();
    const trusted = validSignerIds.length >= request.policy.minimumValidSignatures && missingRequiredSignerIds.length === 0;

    return this.evaluations.create({
      format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust",
      formatVersion: 1,
      evaluationId: request.evaluationId,
      integrityId: request.integrityId,
      policyId: request.policy.policyId,
      policyVersion: request.policy.version,
      decision: trusted ? "trusted" : "untrusted",
      minimumValidSignatures: request.policy.minimumValidSignatures,
      validSignerIds,
      missingRequiredSignerIds,
      signatures: decisions,
      evaluatedAt: this.clock().toISOString(),
    });
  }

  async get(evaluationId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustEvaluationRecord | null> {
    assertText(evaluationId, "evaluationId");
    return this.evaluations.get(evaluationId);
  }

  async history(
    filter: RuntimeFleetHandoffRecoveryEvidenceTrustEvaluationFilter = {},
  ): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceTrustEvaluationRecord[]> {
    return this.evaluations.list(filter);
  }
}

function decision(
  record: RuntimeFleetHandoffRecoveryEvidenceSignatureRecord,
  valid: boolean,
  accepted: boolean,
  reason: string,
): RuntimeFleetHandoffRecoveryEvidenceTrustSignatureDecision {
  return {
    signatureId: record.signatureId,
    signerId: record.signerId,
    algorithm: record.algorithm,
    keyId: record.keyId,
    valid,
    accepted,
    reason,
  };
}

export function validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicy(
  policy: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyDefinition,
): void {
  assertText(policy.policyId, "policyId");
  assertPositiveInteger(policy.version, "policy version");
  assertPositiveInteger(policy.minimumValidSignatures, "minimumValidSignatures");
  if (policy.signers.length === 0) throw new MetadataError("Recovery evidence trust policy requires at least one signer.");
  if (policy.minimumValidSignatures > policy.signers.length) {
    throw new MetadataError("Recovery evidence trust policy quorum cannot exceed the number of allowed signers.");
  }
  const ids = new Set<string>();
  for (const signer of policy.signers) {
    assertText(signer.signerId, "policy signerId");
    if (ids.has(signer.signerId)) throw new MetadataError(`Duplicate recovery evidence trust signer '${signer.signerId}'.`);
    ids.add(signer.signerId);
    validateTextList(signer.allowedAlgorithms, `allowedAlgorithms for '${signer.signerId}'`);
    validateTextList(signer.allowedKeyIds, `allowedKeyIds for '${signer.signerId}'`);
  }
}

export function validateRuntimeFleetHandoffRecoveryEvidenceTrustEvaluationRecord(
  record: RuntimeFleetHandoffRecoveryEvidenceTrustEvaluationRecord,
): void {
  if (
    record.format !== "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust"
    || record.formatVersion !== 1
  ) throw new MetadataError("Unsupported runtime fleet handoff recovery evidence trust format.");
  for (const [label, value] of Object.entries({
    evaluationId: record.evaluationId,
    integrityId: record.integrityId,
    policyId: record.policyId,
    evaluatedAt: record.evaluatedAt,
  })) assertText(value, label);
  assertPositiveInteger(record.policyVersion, "policyVersion");
  assertPositiveInteger(record.minimumValidSignatures, "minimumValidSignatures");
  if (record.decision !== "trusted" && record.decision !== "untrusted") throw new MetadataError("Invalid recovery evidence trust decision.");
  if (!Number.isFinite(Date.parse(record.evaluatedAt))) throw new MetadataError("Recovery evidence trust evaluatedAt must be a valid timestamp.");
  if (new Set(record.validSignerIds).size !== record.validSignerIds.length) throw new MetadataError("Recovery evidence trust validSignerIds must be unique.");
  if (new Set(record.missingRequiredSignerIds).size !== record.missingRequiredSignerIds.length) {
    throw new MetadataError("Recovery evidence trust missingRequiredSignerIds must be unique.");
  }
  for (const signerId of record.validSignerIds) assertText(signerId, "validSignerId");
  for (const signerId of record.missingRequiredSignerIds) assertText(signerId, "missingRequiredSignerId");
  const signatureIds = new Set<string>();
  for (const item of record.signatures) {
    for (const [label, value] of Object.entries({
      signatureId: item.signatureId,
      signerId: item.signerId,
      algorithm: item.algorithm,
      keyId: item.keyId,
      reason: item.reason,
    })) assertText(value, label);
    if (signatureIds.has(item.signatureId)) throw new MetadataError(`Duplicate recovery evidence trust signature '${item.signatureId}'.`);
    signatureIds.add(item.signatureId);
    if (item.accepted && !item.valid) throw new MetadataError("Accepted recovery evidence trust signature must be valid.");
  }
}

function validateTextList(values: readonly string[] | undefined, label: string): void {
  if (values === undefined) return;
  if (values.length === 0) throw new MetadataError(`Recovery evidence trust ${label} cannot be empty when supplied.`);
  const seen = new Set<string>();
  for (const value of values) {
    assertText(value, label);
    if (seen.has(value)) throw new MetadataError(`Recovery evidence trust ${label} contains duplicate '${value}'.`);
    seen.add(value);
  }
}

function assertText(value: string, label: string): void {
  if (!value.trim()) throw new MetadataError(`Runtime fleet handoff recovery evidence trust ${label} is required.`);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new MetadataError(`Runtime fleet handoff recovery evidence trust ${label} must be a positive integer.`);
}
