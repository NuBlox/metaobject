import { ConcurrencyError, MetadataError } from "../errors/errors.js";
import type {
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureRecord,
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureVerification,
} from "./runtime-fleet-convergence-handoff-recovery-trust-policy-lifecycle-signature.js";
import {
  validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureRecord,
} from "./runtime-fleet-convergence-handoff-recovery-trust-policy-lifecycle-signature.js";

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustSignerRequirement {
  readonly signerId: string;
  readonly required?: boolean;
  readonly allowedAlgorithms?: readonly string[];
  readonly allowedKeyIds?: readonly string[];
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustPolicyDefinition {
  readonly policyId: string;
  readonly version: number;
  readonly minimumValidSignatures: number;
  readonly signers: readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustSignerRequirement[];
}

export type RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustDecision = "trusted" | "untrusted";

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustSignatureDecision {
  readonly signatureId: string;
  readonly signerId: string;
  readonly algorithm: string;
  readonly keyId: string;
  readonly valid: boolean;
  readonly accepted: boolean;
  readonly reason: string;
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustEvaluationRecord {
  readonly format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-signature-trust";
  readonly formatVersion: 1;
  readonly evaluationId: string;
  readonly attestationId: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly decision: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustDecision;
  readonly minimumValidSignatures: number;
  readonly validSignerIds: readonly string[];
  readonly missingRequiredSignerIds: readonly string[];
  readonly signatures: readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustSignatureDecision[];
  readonly evaluatedAt: string;
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustEvaluationFilter {
  readonly attestationId?: string;
  readonly policyId?: string;
  readonly decision?: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustDecision;
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustEvaluationStore {
  get(
    evaluationId: string,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustEvaluationRecord | null>;
  list(
    filter?: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustEvaluationFilter,
  ): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustEvaluationRecord[]>;
  create(
    record: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustEvaluationRecord,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustEvaluationRecord>;
}

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustEvaluationStore
implements RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustEvaluationStore {
  readonly #records = new Map<string, RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustEvaluationRecord>();

  async get(
    evaluationId: string,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustEvaluationRecord | null> {
    const record = this.#records.get(evaluationId);
    return record ? clone(record) : null;
  }

  async list(
    filter: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustEvaluationFilter = {},
  ): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustEvaluationRecord[]> {
    return [...this.#records.values()]
      .filter((record) => filter.attestationId === undefined || record.attestationId === filter.attestationId)
      .filter((record) => filter.policyId === undefined || record.policyId === filter.policyId)
      .filter((record) => filter.decision === undefined || record.decision === filter.decision)
      .sort((left, right) => left.evaluatedAt.localeCompare(right.evaluatedAt) || left.evaluationId.localeCompare(right.evaluationId))
      .map(clone);
  }

  async create(
    record: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustEvaluationRecord,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustEvaluationRecord> {
    validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustEvaluationRecord(record);
    if (this.#records.has(record.evaluationId)) {
      throw new ConcurrencyError(`Lifecycle signature trust evaluation '${record.evaluationId}' already exists.`);
    }
    const stored = clone(record);
    this.#records.set(stored.evaluationId, stored);
    return clone(stored);
  }
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustSignatureSource {
  history(
    filter: { readonly attestationId?: string },
  ): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureRecord[]>;
  verify(
    signatureId: string,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureVerification>;
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustRequest {
  readonly evaluationId: string;
  readonly attestationId: string;
  readonly policy: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustPolicyDefinition;
}

export type RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustClock = () => Date;

/**
 * Evaluates M55 lifecycle-signature envelopes under a dedicated trust policy.
 * Distinct signer IDs count once toward quorum and every verification failure
 * fails closed into explicit untrusted evidence.
 */
export class RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustCatalog {
  constructor(
    private readonly signatures: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustSignatureSource,
    private readonly evaluations: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustEvaluationStore,
    private readonly clock: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustClock = () => new Date(),
  ) {}

  async evaluate(
    request: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustRequest,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustEvaluationRecord> {
    assertText(request.evaluationId, "evaluationId");
    assertText(request.attestationId, "attestationId");
    validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustPolicy(request.policy);
    if (await this.evaluations.get(request.evaluationId)) {
      throw new ConcurrencyError(`Lifecycle signature trust evaluation '${request.evaluationId}' already exists.`);
    }

    const requirements = new Map(request.policy.signers.map((item) => [item.signerId, item] as const));
    const records = [...await this.signatures.history({ attestationId: request.attestationId })]
      .sort((left, right) => left.signerId.localeCompare(right.signerId) || left.signatureId.localeCompare(right.signatureId));

    const decisions: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustSignatureDecision[] = [];
    const acceptedBySigner = new Map<string, RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustSignatureDecision>();

    for (const record of records) {
      validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureRecord(record);
      if (record.attestationId !== request.attestationId) {
        decisions.push(decision(record, false, false, "signature belongs to a different lifecycle attestation"));
        continue;
      }
      const requirement = requirements.get(record.signerId);
      if (!requirement) {
        decisions.push(decision(record, false, false, "signer is not allowed by lifecycle trust policy"));
        continue;
      }
      if (requirement.allowedAlgorithms && !requirement.allowedAlgorithms.includes(record.algorithm)) {
        decisions.push(decision(record, false, false, "signature algorithm is not allowed by lifecycle trust policy"));
        continue;
      }
      if (requirement.allowedKeyIds && !requirement.allowedKeyIds.includes(record.keyId)) {
        decisions.push(decision(record, false, false, "signature key is not allowed by lifecycle trust policy"));
        continue;
      }

      let verification: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureVerification;
      try {
        verification = await this.signatures.verify(record.signatureId);
      } catch {
        decisions.push(decision(record, false, false, "signature verification failed closed"));
        continue;
      }
      if (!verification.valid) {
        decisions.push(decision(record, false, false, "lifecycle signature verification is invalid"));
        continue;
      }
      if (acceptedBySigner.has(record.signerId)) {
        decisions.push(decision(record, true, false, "signer already contributed one valid lifecycle signature"));
        continue;
      }
      const accepted = decision(record, true, true, "valid lifecycle signature accepted");
      acceptedBySigner.set(record.signerId, accepted);
      decisions.push(accepted);
    }

    const validSignerIds = [...acceptedBySigner.keys()].sort();
    const missingRequiredSignerIds = request.policy.signers
      .filter((item) => item.required === true && !acceptedBySigner.has(item.signerId))
      .map((item) => item.signerId)
      .sort();
    const trusted = validSignerIds.length >= request.policy.minimumValidSignatures
      && missingRequiredSignerIds.length === 0;

    return this.evaluations.create({
      format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-signature-trust",
      formatVersion: 1,
      evaluationId: request.evaluationId,
      attestationId: request.attestationId,
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

  async get(
    evaluationId: string,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustEvaluationRecord | null> {
    assertText(evaluationId, "evaluationId");
    return this.evaluations.get(evaluationId);
  }

  async history(
    filter: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustEvaluationFilter = {},
  ): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustEvaluationRecord[]> {
    return this.evaluations.list(filter);
  }
}

function decision(
  record: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureRecord,
  valid: boolean,
  accepted: boolean,
  reason: string,
): RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustSignatureDecision {
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

export function validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustPolicy(
  policy: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustPolicyDefinition,
): void {
  assertText(policy.policyId, "policyId");
  assertPositiveInteger(policy.version, "policy version");
  assertPositiveInteger(policy.minimumValidSignatures, "minimumValidSignatures");
  if (policy.signers.length === 0) {
    throw new MetadataError("Lifecycle signature trust policy requires at least one signer.");
  }
  if (policy.minimumValidSignatures > policy.signers.length) {
    throw new MetadataError("Lifecycle signature trust policy quorum cannot exceed the number of allowed signers.");
  }
  const ids = new Set<string>();
  for (const signer of policy.signers) {
    assertText(signer.signerId, "policy signerId");
    if (ids.has(signer.signerId)) {
      throw new MetadataError(`Duplicate lifecycle signature trust signer '${signer.signerId}'.`);
    }
    ids.add(signer.signerId);
    validateTextList(signer.allowedAlgorithms, `allowedAlgorithms for '${signer.signerId}'`);
    validateTextList(signer.allowedKeyIds, `allowedKeyIds for '${signer.signerId}'`);
  }
}

export function validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustEvaluationRecord(
  record: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustEvaluationRecord,
): void {
  if (
    record.format !== "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-signature-trust"
    || record.formatVersion !== 1
  ) {
    throw new MetadataError("Unsupported lifecycle signature trust evaluation format.");
  }
  for (const [label, value] of Object.entries({
    evaluationId: record.evaluationId,
    attestationId: record.attestationId,
    policyId: record.policyId,
    evaluatedAt: record.evaluatedAt,
  })) assertText(value, label);
  assertPositiveInteger(record.policyVersion, "policyVersion");
  assertPositiveInteger(record.minimumValidSignatures, "minimumValidSignatures");
  if (record.decision !== "trusted" && record.decision !== "untrusted") {
    throw new MetadataError("Invalid lifecycle signature trust decision.");
  }
  if (!Number.isFinite(Date.parse(record.evaluatedAt))) {
    throw new MetadataError("Lifecycle signature trust evaluatedAt must be a valid timestamp.");
  }
  if (new Set(record.validSignerIds).size !== record.validSignerIds.length) {
    throw new MetadataError("Lifecycle signature trust validSignerIds must be unique.");
  }
  if (new Set(record.missingRequiredSignerIds).size !== record.missingRequiredSignerIds.length) {
    throw new MetadataError("Lifecycle signature trust missingRequiredSignerIds must be unique.");
  }
  for (const signerId of record.validSignerIds) assertText(signerId, "validSignerId");
  for (const signerId of record.missingRequiredSignerIds) assertText(signerId, "missingRequiredSignerId");

  const signatureIds = new Set<string>();
  const acceptedSignerIds = new Set<string>();
  for (const item of record.signatures) {
    for (const [label, value] of Object.entries({
      signatureId: item.signatureId,
      signerId: item.signerId,
      algorithm: item.algorithm,
      keyId: item.keyId,
      reason: item.reason,
    })) assertText(value, label);
    if (signatureIds.has(item.signatureId)) {
      throw new MetadataError(`Duplicate lifecycle signature trust signature '${item.signatureId}'.`);
    }
    signatureIds.add(item.signatureId);
    if (item.accepted && !item.valid) {
      throw new MetadataError("Accepted lifecycle signature trust evidence must be valid.");
    }
    if (item.accepted) {
      if (acceptedSignerIds.has(item.signerId)) {
        throw new MetadataError(`Lifecycle signature trust signer '${item.signerId}' cannot be accepted twice.`);
      }
      acceptedSignerIds.add(item.signerId);
    }
  }

  const declaredValid = [...record.validSignerIds].sort();
  const derivedValid = [...acceptedSignerIds].sort();
  if (declaredValid.length !== derivedValid.length || declaredValid.some((item, index) => item !== derivedValid[index])) {
    throw new MetadataError("Lifecycle signature trust validSignerIds do not match accepted signature evidence.");
  }
  const shouldBeTrusted = record.validSignerIds.length >= record.minimumValidSignatures
    && record.missingRequiredSignerIds.length === 0;
  if ((record.decision === "trusted") !== shouldBeTrusted) {
    throw new MetadataError("Lifecycle signature trust decision is inconsistent with quorum evidence.");
  }
}

function validateTextList(values: readonly string[] | undefined, label: string): void {
  if (values === undefined) return;
  if (values.length === 0) throw new MetadataError(`Lifecycle signature trust ${label} cannot be empty when supplied.`);
  const seen = new Set<string>();
  for (const value of values) {
    assertText(value, label);
    if (seen.has(value)) throw new MetadataError(`Lifecycle signature trust ${label} contains duplicate '${value}'.`);
    seen.add(value);
  }
}

function assertText(value: string, label: string): void {
  if (!value.trim()) throw new MetadataError(`Lifecycle signature trust ${label} is required.`);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new MetadataError(`Lifecycle signature trust ${label} must be a positive integer.`);
  }
}
