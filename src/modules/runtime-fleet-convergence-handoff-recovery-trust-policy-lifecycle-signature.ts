import { ConcurrencyError, MetadataError } from "../errors/errors.js";
import { canonicalizeJson, sha256Hex } from "./runtime-fleet-convergence-handoff-recovery-integrity.js";
import type {
  RuntimeFleetHandoffRecoveryEvidenceSignatureMaterial,
} from "./runtime-fleet-convergence-handoff-recovery-signature.js";
import {
  RuntimeFleetHandoffRecoveryEvidenceSignatureProviderRegistry,
} from "./runtime-fleet-convergence-handoff-recovery-signature.js";
import type {
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityRecord,
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityVerification,
} from "./runtime-fleet-convergence-handoff-recovery-trust-policy-lifecycle-integrity.js";
import {
  validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityRecord,
} from "./runtime-fleet-convergence-handoff-recovery-trust-policy-lifecycle-integrity.js";

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureRecord {
  readonly format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-signature";
  readonly formatVersion: 1;
  readonly signatureId: string;
  readonly attestationId: string;
  readonly policyId: string;
  readonly lifecycleRevision: number;
  readonly lifecycleStatus: "active" | "retired";
  readonly snapshotId: string;
  readonly policyVersion: number;
  readonly rootDigest: string;
  readonly currentStateDigest: string;
  readonly signerId: string;
  readonly algorithm: string;
  readonly keyId: string;
  readonly signature: string;
  readonly payloadDigest: string;
  readonly signedAt: string;
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureFilter {
  readonly attestationId?: string;
  readonly policyId?: string;
  readonly signerId?: string;
  readonly keyId?: string;
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureStore {
  get(signatureId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureRecord | null>;
  list(
    filter?: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureFilter,
  ): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureRecord[]>;
  create(
    record: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureRecord,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureRecord>;
}

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureStore
implements RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureStore {
  readonly #records = new Map<string, RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureRecord>();

  async get(signatureId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureRecord | null> {
    const record = this.#records.get(signatureId);
    return record ? clone(record) : null;
  }

  async list(
    filter: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureFilter = {},
  ): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureRecord[]> {
    return [...this.#records.values()]
      .filter((record) => filter.attestationId === undefined || record.attestationId === filter.attestationId)
      .filter((record) => filter.policyId === undefined || record.policyId === filter.policyId)
      .filter((record) => filter.signerId === undefined || record.signerId === filter.signerId)
      .filter((record) => filter.keyId === undefined || record.keyId === filter.keyId)
      .sort((left, right) => left.signedAt.localeCompare(right.signedAt) || left.signatureId.localeCompare(right.signatureId))
      .map(clone);
  }

  async create(
    record: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureRecord,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureRecord> {
    validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureRecord(record);
    if (this.#records.has(record.signatureId)) {
      throw new ConcurrencyError(`Recovery evidence trust policy lifecycle signature '${record.signatureId}' already exists.`);
    }
    const stored = clone(record);
    this.#records.set(stored.signatureId, stored);
    return clone(stored);
  }
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegritySource {
  get(attestationId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityRecord | null>;
  verify(attestationId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityVerification>;
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureRequest {
  readonly signatureId: string;
  readonly attestationId: string;
  readonly signerId: string;
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureVerification {
  readonly signatureId: string;
  readonly valid: boolean;
  readonly lifecycleIntegrityValid: boolean;
  readonly payloadMatches: boolean;
  readonly signatureValid: boolean;
  readonly verifiedAt: string;
}

export type RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureClock = () => Date;

/**
 * Adds an external cryptographic trust anchor to one exact M54 lifecycle
 * integrity root. Signing providers remain external and reusable through the
 * M50 provider registry; this package stores no private keys.
 */
export class RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureCatalog {
  constructor(
    private readonly integrity: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegritySource,
    private readonly providers: RuntimeFleetHandoffRecoveryEvidenceSignatureProviderRegistry,
    private readonly signatures: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureStore,
    private readonly clock: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureClock = () => new Date(),
  ) {}

  async sign(
    request: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureRequest,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureRecord> {
    assertText(request.signatureId, "signatureId");
    assertText(request.attestationId, "attestationId");
    assertText(request.signerId, "signerId");
    if (await this.signatures.get(request.signatureId)) {
      throw new ConcurrencyError(`Recovery evidence trust policy lifecycle signature '${request.signatureId}' already exists.`);
    }

    const integrity = await this.requireIntegrity(request.attestationId);
    const verification = await this.integrity.verify(integrity.attestationId);
    if (!verification.valid) {
      throw new MetadataError(
        `Recovery evidence trust policy lifecycle integrity '${integrity.attestationId}' is no longer valid and cannot be signed.`,
      );
    }

    const payload = lifecycleSignaturePayload(integrity);
    const provider = this.providers.get(request.signerId);
    const material = await provider.sign(payload);
    validateMaterial(material);
    const record: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureRecord = {
      format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-signature",
      formatVersion: 1,
      signatureId: request.signatureId,
      attestationId: integrity.attestationId,
      policyId: integrity.policyId,
      lifecycleRevision: integrity.lifecycleRevision,
      lifecycleStatus: integrity.lifecycleStatus,
      snapshotId: integrity.snapshotId,
      policyVersion: integrity.policyVersion,
      rootDigest: integrity.rootDigest,
      currentStateDigest: integrity.currentStateDigest,
      signerId: provider.signerId,
      algorithm: material.algorithm,
      keyId: material.keyId,
      signature: material.signature,
      payloadDigest: await sha256Hex(payload),
      signedAt: this.clock().toISOString(),
    };
    return this.signatures.create(record);
  }

  async verify(
    signatureId: string,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureVerification> {
    assertText(signatureId, "signatureId");
    const record = await this.signatures.get(signatureId);
    if (!record) throw new MetadataError(`Unknown recovery evidence trust policy lifecycle signature '${signatureId}'.`);
    validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureRecord(record);

    const integrity = await this.requireIntegrity(record.attestationId);
    const integrityVerification = await this.integrity.verify(integrity.attestationId);
    const payload = lifecycleSignaturePayload(integrity);
    const payloadDigest = await sha256Hex(payload);
    const payloadMatches = record.policyId === integrity.policyId
      && record.lifecycleRevision === integrity.lifecycleRevision
      && record.lifecycleStatus === integrity.lifecycleStatus
      && record.snapshotId === integrity.snapshotId
      && record.policyVersion === integrity.policyVersion
      && record.rootDigest === integrity.rootDigest
      && record.currentStateDigest === integrity.currentStateDigest
      && record.payloadDigest === payloadDigest;

    let signatureValid = false;
    if (payloadMatches) {
      try {
        const provider = this.providers.get(record.signerId);
        signatureValid = await provider.verify(payload, {
          algorithm: record.algorithm,
          keyId: record.keyId,
          signature: record.signature,
        });
      } catch {
        signatureValid = false;
      }
    }

    return {
      signatureId: record.signatureId,
      valid: integrityVerification.valid && payloadMatches && signatureValid,
      lifecycleIntegrityValid: integrityVerification.valid,
      payloadMatches,
      signatureValid,
      verifiedAt: this.clock().toISOString(),
    };
  }

  async get(signatureId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureRecord | null> {
    assertText(signatureId, "signatureId");
    return this.signatures.get(signatureId);
  }

  async history(
    filter: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureFilter = {},
  ): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureRecord[]> {
    return this.signatures.list(filter);
  }

  private async requireIntegrity(
    attestationId: string,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityRecord> {
    const record = await this.integrity.get(attestationId);
    if (!record) {
      throw new MetadataError(`Unknown recovery evidence trust policy lifecycle integrity '${attestationId}'.`);
    }
    validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityRecord(record);
    return record;
  }
}

export function lifecycleSignaturePayload(
  integrity: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityRecord,
): string {
  validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityRecord(integrity);
  return canonicalizeJson({
    format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-signature-payload",
    formatVersion: 1,
    attestationId: integrity.attestationId,
    policyId: integrity.policyId,
    lifecycleRevision: integrity.lifecycleRevision,
    lifecycleStatus: integrity.lifecycleStatus,
    snapshotId: integrity.snapshotId,
    policyVersion: integrity.policyVersion,
    rootDigest: integrity.rootDigest,
    currentStateDigest: integrity.currentStateDigest,
    digestAlgorithm: integrity.algorithm,
    canonicalization: integrity.canonicalization,
  });
}

export function validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureRecord(
  record: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureRecord,
): void {
  if (
    record.format !== "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-signature"
    || record.formatVersion !== 1
  ) {
    throw new MetadataError("Unsupported recovery evidence trust policy lifecycle signature format.");
  }
  for (const [label, value] of Object.entries({
    signatureId: record.signatureId,
    attestationId: record.attestationId,
    policyId: record.policyId,
    snapshotId: record.snapshotId,
    rootDigest: record.rootDigest,
    currentStateDigest: record.currentStateDigest,
    signerId: record.signerId,
    algorithm: record.algorithm,
    keyId: record.keyId,
    signature: record.signature,
    payloadDigest: record.payloadDigest,
    signedAt: record.signedAt,
  })) assertText(value, label);
  assertPositiveInteger(record.lifecycleRevision, "lifecycleRevision");
  assertPositiveInteger(record.policyVersion, "policyVersion");
  if (record.lifecycleStatus !== "active" && record.lifecycleStatus !== "retired") {
    throw new MetadataError("Invalid recovery evidence trust policy lifecycle signature status.");
  }
  assertDigest(record.rootDigest, "rootDigest");
  assertDigest(record.currentStateDigest, "currentStateDigest");
  assertDigest(record.payloadDigest, "payloadDigest");
  if (!Number.isFinite(Date.parse(record.signedAt))) {
    throw new MetadataError("Recovery evidence trust policy lifecycle signature signedAt must be a valid timestamp.");
  }
}

function validateMaterial(material: RuntimeFleetHandoffRecoveryEvidenceSignatureMaterial): void {
  assertText(material.algorithm, "algorithm");
  assertText(material.keyId, "keyId");
  assertText(material.signature, "signature");
}

function assertDigest(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new MetadataError(`Recovery evidence trust policy lifecycle signature ${label} must be a SHA-256 hex digest.`);
  }
}

function assertText(value: string, label: string): void {
  if (!value.trim()) throw new MetadataError(`Recovery evidence trust policy lifecycle signature ${label} is required.`);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new MetadataError(`Recovery evidence trust policy lifecycle signature ${label} must be a positive integer.`);
  }
}
