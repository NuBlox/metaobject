import { ConcurrencyError, MetadataError } from "../errors/errors.js";
import type {
  RuntimeFleetHandoffRecoveryEvidenceIntegrityCatalog,
  RuntimeFleetHandoffRecoveryEvidenceIntegrityRecord,
  RuntimeFleetHandoffRecoveryEvidenceVerification,
} from "./runtime-fleet-convergence-handoff-recovery-integrity.js";
import {
  canonicalizeJson,
  sha256Hex,
  validateRuntimeFleetHandoffRecoveryEvidenceIntegrityRecord,
} from "./runtime-fleet-convergence-handoff-recovery-integrity.js";

export interface RuntimeFleetHandoffRecoveryEvidenceSignatureMaterial {
  readonly algorithm: string;
  readonly keyId: string;
  readonly signature: string;
}

export interface RuntimeFleetHandoffRecoveryEvidenceSignatureProvider {
  readonly signerId: string;
  sign(payload: string): Promise<RuntimeFleetHandoffRecoveryEvidenceSignatureMaterial>;
  verify(payload: string, material: RuntimeFleetHandoffRecoveryEvidenceSignatureMaterial): Promise<boolean>;
}

export class RuntimeFleetHandoffRecoveryEvidenceSignatureProviderRegistry {
  readonly #providers = new Map<string, RuntimeFleetHandoffRecoveryEvidenceSignatureProvider>();

  register(provider: RuntimeFleetHandoffRecoveryEvidenceSignatureProvider): void {
    assertText(provider.signerId, "signerId");
    if (this.#providers.has(provider.signerId)) {
      throw new MetadataError(`Recovery evidence signature provider '${provider.signerId}' is already registered.`);
    }
    this.#providers.set(provider.signerId, provider);
  }

  get(signerId: string): RuntimeFleetHandoffRecoveryEvidenceSignatureProvider {
    assertText(signerId, "signerId");
    const provider = this.#providers.get(signerId);
    if (!provider) throw new MetadataError(`Unknown recovery evidence signature provider '${signerId}'.`);
    return provider;
  }
}

export interface RuntimeFleetHandoffRecoveryEvidenceSignatureRecord {
  readonly format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-signature";
  readonly formatVersion: 1;
  readonly signatureId: string;
  readonly integrityId: string;
  readonly attestationId: string;
  readonly recoveryId: string;
  readonly rootDigest: string;
  readonly signerId: string;
  readonly algorithm: string;
  readonly keyId: string;
  readonly signature: string;
  readonly payloadDigest: string;
  readonly signedAt: string;
}

export interface RuntimeFleetHandoffRecoveryEvidenceSignatureFilter {
  readonly integrityId?: string;
  readonly attestationId?: string;
  readonly signerId?: string;
  readonly keyId?: string;
}

export interface RuntimeFleetHandoffRecoveryEvidenceSignatureStore {
  get(signatureId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceSignatureRecord | null>;
  list(
    filter?: RuntimeFleetHandoffRecoveryEvidenceSignatureFilter,
  ): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceSignatureRecord[]>;
  create(
    record: RuntimeFleetHandoffRecoveryEvidenceSignatureRecord,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceSignatureRecord>;
}

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryRuntimeFleetHandoffRecoveryEvidenceSignatureStore
implements RuntimeFleetHandoffRecoveryEvidenceSignatureStore {
  readonly #records = new Map<string, RuntimeFleetHandoffRecoveryEvidenceSignatureRecord>();

  async get(signatureId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceSignatureRecord | null> {
    const record = this.#records.get(signatureId);
    return record ? clone(record) : null;
  }

  async list(
    filter: RuntimeFleetHandoffRecoveryEvidenceSignatureFilter = {},
  ): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceSignatureRecord[]> {
    return [...this.#records.values()]
      .filter((record) => filter.integrityId === undefined || record.integrityId === filter.integrityId)
      .filter((record) => filter.attestationId === undefined || record.attestationId === filter.attestationId)
      .filter((record) => filter.signerId === undefined || record.signerId === filter.signerId)
      .filter((record) => filter.keyId === undefined || record.keyId === filter.keyId)
      .sort((left, right) => left.signedAt.localeCompare(right.signedAt) || left.signatureId.localeCompare(right.signatureId))
      .map(clone);
  }

  async create(
    record: RuntimeFleetHandoffRecoveryEvidenceSignatureRecord,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceSignatureRecord> {
    validateRuntimeFleetHandoffRecoveryEvidenceSignatureRecord(record);
    if (this.#records.has(record.signatureId)) {
      throw new ConcurrencyError(`Runtime fleet handoff recovery evidence signature '${record.signatureId}' already exists.`);
    }
    const stored = clone(record);
    this.#records.set(stored.signatureId, stored);
    return clone(stored);
  }
}

export interface RuntimeFleetHandoffRecoveryEvidenceIntegritySource {
  get(integrityId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceIntegrityRecord | null>;
  verify(integrityId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceVerification>;
}

export interface RuntimeFleetHandoffRecoveryEvidenceSignatureRequest {
  readonly signatureId: string;
  readonly integrityId: string;
  readonly signerId: string;
}

export interface RuntimeFleetHandoffRecoveryEvidenceSignatureVerification {
  readonly signatureId: string;
  readonly valid: boolean;
  readonly integrityValid: boolean;
  readonly payloadMatches: boolean;
  readonly signatureValid: boolean;
  readonly verifiedAt: string;
}

export type RuntimeFleetHandoffRecoveryEvidenceSignatureClock = () => Date;

export class RuntimeFleetHandoffRecoveryEvidenceSignatureCatalog {
  constructor(
    private readonly integrity: RuntimeFleetHandoffRecoveryEvidenceIntegritySource,
    private readonly providers: RuntimeFleetHandoffRecoveryEvidenceSignatureProviderRegistry,
    private readonly signatures: RuntimeFleetHandoffRecoveryEvidenceSignatureStore,
    private readonly clock: RuntimeFleetHandoffRecoveryEvidenceSignatureClock = () => new Date(),
  ) {}

  async sign(
    request: RuntimeFleetHandoffRecoveryEvidenceSignatureRequest,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceSignatureRecord> {
    assertText(request.signatureId, "signatureId");
    assertText(request.integrityId, "integrityId");
    assertText(request.signerId, "signerId");
    if (await this.signatures.get(request.signatureId)) {
      throw new ConcurrencyError(`Runtime fleet handoff recovery evidence signature '${request.signatureId}' already exists.`);
    }

    const integrity = await this.requireIntegrity(request.integrityId);
    const integrityVerification = await this.integrity.verify(integrity.integrityId);
    if (!integrityVerification.valid) {
      throw new MetadataError(
        `Recovery evidence integrity '${integrity.integrityId}' is no longer valid and cannot be signed.`,
      );
    }

    const payload = signaturePayload(integrity);
    const provider = this.providers.get(request.signerId);
    const material = await provider.sign(payload);
    validateMaterial(material);
    const record: RuntimeFleetHandoffRecoveryEvidenceSignatureRecord = {
      format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-signature",
      formatVersion: 1,
      signatureId: request.signatureId,
      integrityId: integrity.integrityId,
      attestationId: integrity.attestationId,
      recoveryId: integrity.recoveryId,
      rootDigest: integrity.rootDigest,
      signerId: provider.signerId,
      algorithm: material.algorithm,
      keyId: material.keyId,
      signature: material.signature,
      payloadDigest: await sha256Hex(payload),
      signedAt: this.clock().toISOString(),
    };
    return this.signatures.create(record);
  }

  async verify(signatureId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceSignatureVerification> {
    assertText(signatureId, "signatureId");
    const record = await this.signatures.get(signatureId);
    if (!record) throw new MetadataError(`Unknown recovery evidence signature '${signatureId}'.`);
    validateRuntimeFleetHandoffRecoveryEvidenceSignatureRecord(record);

    const integrity = await this.requireIntegrity(record.integrityId);
    const integrityVerification = await this.integrity.verify(integrity.integrityId);
    const payload = signaturePayload(integrity);
    const payloadDigest = await sha256Hex(payload);
    const payloadMatches =
      record.attestationId === integrity.attestationId
      && record.recoveryId === integrity.recoveryId
      && record.rootDigest === integrity.rootDigest
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
      integrityValid: integrityVerification.valid,
      payloadMatches,
      signatureValid,
      verifiedAt: this.clock().toISOString(),
    };
  }

  async get(signatureId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceSignatureRecord | null> {
    assertText(signatureId, "signatureId");
    return this.signatures.get(signatureId);
  }

  async history(
    filter: RuntimeFleetHandoffRecoveryEvidenceSignatureFilter = {},
  ): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceSignatureRecord[]> {
    return this.signatures.list(filter);
  }

  private async requireIntegrity(integrityId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceIntegrityRecord> {
    const record = await this.integrity.get(integrityId);
    if (!record) throw new MetadataError(`Unknown recovery evidence integrity '${integrityId}'.`);
    validateRuntimeFleetHandoffRecoveryEvidenceIntegrityRecord(record);
    return record;
  }
}

export function signaturePayload(integrity: RuntimeFleetHandoffRecoveryEvidenceIntegrityRecord): string {
  validateRuntimeFleetHandoffRecoveryEvidenceIntegrityRecord(integrity);
  return canonicalizeJson({
    format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-signature-payload",
    formatVersion: 1,
    integrityId: integrity.integrityId,
    attestationId: integrity.attestationId,
    recoveryId: integrity.recoveryId,
    rootDigest: integrity.rootDigest,
    digestAlgorithm: integrity.algorithm,
    canonicalization: integrity.canonicalization,
  });
}

export function validateRuntimeFleetHandoffRecoveryEvidenceSignatureRecord(
  record: RuntimeFleetHandoffRecoveryEvidenceSignatureRecord,
): void {
  if (
    record.format !== "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-signature"
    || record.formatVersion !== 1
  ) {
    throw new MetadataError("Unsupported runtime fleet handoff recovery evidence signature format.");
  }
  for (const [label, value] of Object.entries({
    signatureId: record.signatureId,
    integrityId: record.integrityId,
    attestationId: record.attestationId,
    recoveryId: record.recoveryId,
    rootDigest: record.rootDigest,
    signerId: record.signerId,
    algorithm: record.algorithm,
    keyId: record.keyId,
    signature: record.signature,
    payloadDigest: record.payloadDigest,
    signedAt: record.signedAt,
  })) assertText(value, label);
  if (!/^[0-9a-f]{64}$/.test(record.rootDigest)) {
    throw new MetadataError("Recovery evidence signature rootDigest must be lowercase SHA-256 hex.");
  }
  if (!/^[0-9a-f]{64}$/.test(record.payloadDigest)) {
    throw new MetadataError("Recovery evidence signature payloadDigest must be lowercase SHA-256 hex.");
  }
  if (!Number.isFinite(Date.parse(record.signedAt))) {
    throw new MetadataError("Recovery evidence signature signedAt must be a valid timestamp.");
  }
}

function validateMaterial(material: RuntimeFleetHandoffRecoveryEvidenceSignatureMaterial): void {
  assertText(material.algorithm, "algorithm");
  assertText(material.keyId, "keyId");
  assertText(material.signature, "signature");
}

function assertText(value: string, label: string): void {
  if (!value.trim()) throw new MetadataError(`Runtime fleet handoff recovery evidence signature ${label} is required.`);
}
