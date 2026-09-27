import { ConcurrencyError, MetadataError } from "../errors/errors.js";
import { canonicalizeJson, sha256Hex } from "./runtime-fleet-convergence-handoff-recovery-integrity.js";
import type {
  RuntimeFleetHandoffRecoveryEvidenceTrustDecision,
  RuntimeFleetHandoffRecoveryEvidenceTrustEvaluationRecord,
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyDefinition,
  RuntimeFleetHandoffRecoveryEvidenceTrustRequest,
} from "./runtime-fleet-convergence-handoff-recovery-trust.js";
import {
  validateRuntimeFleetHandoffRecoveryEvidenceTrustEvaluationRecord,
  validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicy,
} from "./runtime-fleet-convergence-handoff-recovery-trust.js";

export type RuntimeFleetHandoffRecoveryEvidenceTrustPolicyDigestAlgorithm = "SHA-256";
export type RuntimeFleetHandoffRecoveryEvidenceTrustPolicyCanonicalization = "nublox-json-canonical-v1";

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotRecord {
  readonly format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-snapshot";
  readonly formatVersion: 1;
  readonly snapshotId: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly algorithm: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyDigestAlgorithm;
  readonly canonicalization: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyCanonicalization;
  readonly policy: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyDefinition;
  readonly policyDigest: string;
  readonly publishedAt: string;
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotFilter {
  readonly policyId?: string;
  readonly policyVersion?: number;
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotStore {
  get(snapshotId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotRecord | null>;
  getByIdentity(
    policyId: string,
    policyVersion: number,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotRecord | null>;
  list(
    filter?: RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotFilter,
  ): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotRecord[]>;
  create(
    record: RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotRecord,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotRecord>;
}

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotStore
implements RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotStore {
  readonly #records = new Map<string, RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotRecord>();
  readonly #identity = new Map<string, string>();

  async get(snapshotId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotRecord | null> {
    const record = this.#records.get(snapshotId);
    return record ? clone(record) : null;
  }

  async getByIdentity(
    policyId: string,
    policyVersion: number,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotRecord | null> {
    const snapshotId = this.#identity.get(identityKey(policyId, policyVersion));
    if (!snapshotId) return null;
    const record = this.#records.get(snapshotId);
    return record ? clone(record) : null;
  }

  async list(
    filter: RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotFilter = {},
  ): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotRecord[]> {
    return [...this.#records.values()]
      .filter((record) => filter.policyId === undefined || record.policyId === filter.policyId)
      .filter((record) => filter.policyVersion === undefined || record.policyVersion === filter.policyVersion)
      .sort((left, right) => left.publishedAt.localeCompare(right.publishedAt) || left.snapshotId.localeCompare(right.snapshotId))
      .map(clone);
  }

  async create(
    record: RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotRecord,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotRecord> {
    validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotRecord(record);
    if (this.#records.has(record.snapshotId)) {
      throw new ConcurrencyError(`Recovery evidence trust policy snapshot '${record.snapshotId}' already exists.`);
    }
    const key = identityKey(record.policyId, record.policyVersion);
    const existing = this.#identity.get(key);
    if (existing) {
      throw new ConcurrencyError(
        `Recovery evidence trust policy '${record.policyId}@${record.policyVersion}' is already published as snapshot '${existing}'.`,
      );
    }
    const stored = clone(record);
    this.#records.set(stored.snapshotId, stored);
    this.#identity.set(key, stored.snapshotId);
    return clone(stored);
  }
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyPublishRequest {
  readonly snapshotId: string;
  readonly policy: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyDefinition;
}

export type RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotClock = () => Date;

/** Publish one immutable canonical snapshot for an exact policyId/version identity. */
export class RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotCatalog {
  constructor(
    private readonly snapshots: RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotStore,
    private readonly clock: RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotClock = () => new Date(),
  ) {}

  async publish(
    request: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyPublishRequest,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotRecord> {
    assertText(request.snapshotId, "snapshotId");
    validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicy(request.policy);

    const existingId = await this.snapshots.get(request.snapshotId);
    if (existingId) {
      throw new ConcurrencyError(`Recovery evidence trust policy snapshot '${request.snapshotId}' already exists.`);
    }
    const existingIdentity = await this.snapshots.getByIdentity(request.policy.policyId, request.policy.version);
    if (existingIdentity) {
      throw new ConcurrencyError(
        `Recovery evidence trust policy '${request.policy.policyId}@${request.policy.version}' is already published as snapshot '${existingIdentity.snapshotId}'.`,
      );
    }

    const policy = clone(request.policy);
    const policyDigest = await digestTrustPolicy(policy);
    return this.snapshots.create({
      format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-snapshot",
      formatVersion: 1,
      snapshotId: request.snapshotId,
      policyId: policy.policyId,
      policyVersion: policy.version,
      algorithm: "SHA-256",
      canonicalization: "nublox-json-canonical-v1",
      policy,
      policyDigest,
      publishedAt: this.clock().toISOString(),
    });
  }

  async get(snapshotId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotRecord | null> {
    assertText(snapshotId, "snapshotId");
    return this.snapshots.get(snapshotId);
  }

  async resolve(
    policyId: string,
    policyVersion: number,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotRecord | null> {
    assertText(policyId, "policyId");
    assertPositiveInteger(policyVersion, "policyVersion");
    return this.snapshots.getByIdentity(policyId, policyVersion);
  }

  async history(
    filter: RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotFilter = {},
  ): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotRecord[]> {
    return this.snapshots.list(filter);
  }
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyBoundRecord {
  readonly format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-bound";
  readonly formatVersion: 1;
  readonly bindingId: string;
  readonly evaluationId: string;
  readonly integrityId: string;
  readonly snapshotId: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly policyDigest: string;
  readonly decision: RuntimeFleetHandoffRecoveryEvidenceTrustDecision;
  readonly evaluatedAt: string;
  readonly boundAt: string;
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyBoundFilter {
  readonly integrityId?: string;
  readonly policyId?: string;
  readonly decision?: RuntimeFleetHandoffRecoveryEvidenceTrustDecision;
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyBoundStore {
  get(bindingId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyBoundRecord | null>;
  list(
    filter?: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyBoundFilter,
  ): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyBoundRecord[]>;
  create(
    record: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyBoundRecord,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyBoundRecord>;
}

export class MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyBoundStore
implements RuntimeFleetHandoffRecoveryEvidenceTrustPolicyBoundStore {
  readonly #records = new Map<string, RuntimeFleetHandoffRecoveryEvidenceTrustPolicyBoundRecord>();

  async get(bindingId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyBoundRecord | null> {
    const record = this.#records.get(bindingId);
    return record ? clone(record) : null;
  }

  async list(
    filter: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyBoundFilter = {},
  ): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyBoundRecord[]> {
    return [...this.#records.values()]
      .filter((record) => filter.integrityId === undefined || record.integrityId === filter.integrityId)
      .filter((record) => filter.policyId === undefined || record.policyId === filter.policyId)
      .filter((record) => filter.decision === undefined || record.decision === filter.decision)
      .sort((left, right) => left.boundAt.localeCompare(right.boundAt) || left.bindingId.localeCompare(right.bindingId))
      .map(clone);
  }

  async create(
    record: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyBoundRecord,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyBoundRecord> {
    validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyBoundRecord(record);
    if (this.#records.has(record.bindingId)) {
      throw new ConcurrencyError(`Recovery evidence trust policy binding '${record.bindingId}' already exists.`);
    }
    const stored = clone(record);
    this.#records.set(stored.bindingId, stored);
    return clone(stored);
  }
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustEvaluationSource {
  get(evaluationId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustEvaluationRecord | null>;
  evaluate(request: RuntimeFleetHandoffRecoveryEvidenceTrustRequest): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustEvaluationRecord>;
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyBoundRequest {
  readonly bindingId: string;
  readonly evaluationId: string;
  readonly integrityId: string;
  readonly snapshotId: string;
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyBoundVerification {
  readonly bindingId: string;
  readonly valid: boolean;
  readonly policyDigestMatches: boolean;
  readonly evaluationMatches: boolean;
  readonly verifiedAt: string;
}

export type RuntimeFleetHandoffRecoveryEvidenceTrustPolicyBoundClock = () => Date;

/**
 * Recommended M52 entrypoint for trust evaluation. The M51 decision is created
 * only from an immutable published policy snapshot, then permanently bound to
 * that snapshot digest. Existing M51 records remain readable and can be bound
 * after a crash when their identity exactly matches the snapshot.
 */
export class RuntimeFleetHandoffRecoveryEvidenceTrustPolicyBoundCatalog {
  constructor(
    private readonly snapshots: RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotStore,
    private readonly trust: RuntimeFleetHandoffRecoveryEvidenceTrustEvaluationSource,
    private readonly bindings: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyBoundStore,
    private readonly clock: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyBoundClock = () => new Date(),
  ) {}

  async evaluate(
    request: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyBoundRequest,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyBoundRecord> {
    for (const [label, value] of Object.entries({
      bindingId: request.bindingId,
      evaluationId: request.evaluationId,
      integrityId: request.integrityId,
      snapshotId: request.snapshotId,
    })) assertText(value, label);

    const existingBinding = await this.bindings.get(request.bindingId);
    if (existingBinding) {
      if (
        existingBinding.evaluationId === request.evaluationId
        && existingBinding.integrityId === request.integrityId
        && existingBinding.snapshotId === request.snapshotId
      ) return existingBinding;
      throw new ConcurrencyError(`Recovery evidence trust policy binding '${request.bindingId}' already exists with different identity.`);
    }

    const snapshot = await this.requireSnapshot(request.snapshotId);
    const digest = await digestTrustPolicy(snapshot.policy);
    if (digest !== snapshot.policyDigest) {
      throw new MetadataError(`Recovery evidence trust policy snapshot '${snapshot.snapshotId}' no longer matches its immutable digest.`);
    }

    let evaluation = await this.trust.get(request.evaluationId);
    if (evaluation === null) {
      evaluation = await this.trust.evaluate({
        evaluationId: request.evaluationId,
        integrityId: request.integrityId,
        policy: clone(snapshot.policy),
      });
    }
    assertEvaluationMatchesSnapshot(evaluation, snapshot, request.integrityId);

    return this.bindings.create({
      format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-bound",
      formatVersion: 1,
      bindingId: request.bindingId,
      evaluationId: evaluation.evaluationId,
      integrityId: evaluation.integrityId,
      snapshotId: snapshot.snapshotId,
      policyId: snapshot.policyId,
      policyVersion: snapshot.policyVersion,
      policyDigest: snapshot.policyDigest,
      decision: evaluation.decision,
      evaluatedAt: evaluation.evaluatedAt,
      boundAt: this.clock().toISOString(),
    });
  }

  async verify(bindingId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyBoundVerification> {
    assertText(bindingId, "bindingId");
    const binding = await this.bindings.get(bindingId);
    if (!binding) throw new MetadataError(`Unknown recovery evidence trust policy binding '${bindingId}'.`);
    validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyBoundRecord(binding);

    const snapshot = await this.snapshots.get(binding.snapshotId);
    const evaluation = await this.trust.get(binding.evaluationId);
    if (!snapshot || !evaluation) {
      return {
        bindingId,
        valid: false,
        policyDigestMatches: false,
        evaluationMatches: false,
        verifiedAt: this.clock().toISOString(),
      };
    }

    let policyDigestMatches = false;
    try {
      validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotRecord(snapshot);
      policyDigestMatches = await digestTrustPolicy(snapshot.policy) === binding.policyDigest
        && snapshot.policyDigest === binding.policyDigest;
    } catch {
      policyDigestMatches = false;
    }

    let evaluationMatches = false;
    try {
      validateRuntimeFleetHandoffRecoveryEvidenceTrustEvaluationRecord(evaluation);
      evaluationMatches = evaluation.evaluationId === binding.evaluationId
        && evaluation.integrityId === binding.integrityId
        && evaluation.policyId === binding.policyId
        && evaluation.policyVersion === binding.policyVersion
        && evaluation.decision === binding.decision
        && evaluation.evaluatedAt === binding.evaluatedAt;
    } catch {
      evaluationMatches = false;
    }

    return {
      bindingId,
      valid: policyDigestMatches && evaluationMatches,
      policyDigestMatches,
      evaluationMatches,
      verifiedAt: this.clock().toISOString(),
    };
  }

  async get(bindingId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyBoundRecord | null> {
    assertText(bindingId, "bindingId");
    return this.bindings.get(bindingId);
  }

  async history(
    filter: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyBoundFilter = {},
  ): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyBoundRecord[]> {
    return this.bindings.list(filter);
  }

  private async requireSnapshot(snapshotId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotRecord> {
    const snapshot = await this.snapshots.get(snapshotId);
    if (!snapshot) throw new MetadataError(`Unknown recovery evidence trust policy snapshot '${snapshotId}'.`);
    validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotRecord(snapshot);
    return snapshot;
  }
}

export async function digestTrustPolicy(
  policy: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyDefinition,
): Promise<string> {
  validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicy(policy);
  return sha256Hex(canonicalizeJson({
    format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy",
    formatVersion: 1,
    policy,
  }));
}

export function validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotRecord(
  record: RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotRecord,
): void {
  if (
    record.format !== "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-snapshot"
    || record.formatVersion !== 1
  ) throw new MetadataError("Unsupported recovery evidence trust policy snapshot format.");
  for (const [label, value] of Object.entries({
    snapshotId: record.snapshotId,
    policyId: record.policyId,
    policyDigest: record.policyDigest,
    publishedAt: record.publishedAt,
  })) assertText(value, label);
  assertPositiveInteger(record.policyVersion, "policyVersion");
  if (record.algorithm !== "SHA-256") throw new MetadataError("Unsupported recovery evidence trust policy digest algorithm.");
  if (record.canonicalization !== "nublox-json-canonical-v1") {
    throw new MetadataError("Unsupported recovery evidence trust policy canonicalization.");
  }
  if (!/^[0-9a-f]{64}$/.test(record.policyDigest)) throw new MetadataError("Recovery evidence trust policy digest must be a SHA-256 hex digest.");
  if (!Number.isFinite(Date.parse(record.publishedAt))) throw new MetadataError("Recovery evidence trust policy publishedAt must be a valid timestamp.");
  validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicy(record.policy);
  if (record.policy.policyId !== record.policyId || record.policy.version !== record.policyVersion) {
    throw new MetadataError("Recovery evidence trust policy snapshot identity does not match its embedded policy.");
  }
}

export function validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyBoundRecord(
  record: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyBoundRecord,
): void {
  if (
    record.format !== "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-bound"
    || record.formatVersion !== 1
  ) throw new MetadataError("Unsupported recovery evidence trust policy binding format.");
  for (const [label, value] of Object.entries({
    bindingId: record.bindingId,
    evaluationId: record.evaluationId,
    integrityId: record.integrityId,
    snapshotId: record.snapshotId,
    policyId: record.policyId,
    policyDigest: record.policyDigest,
    evaluatedAt: record.evaluatedAt,
    boundAt: record.boundAt,
  })) assertText(value, label);
  assertPositiveInteger(record.policyVersion, "policyVersion");
  if (!/^[0-9a-f]{64}$/.test(record.policyDigest)) throw new MetadataError("Recovery evidence trust policy binding digest must be a SHA-256 hex digest.");
  if (record.decision !== "trusted" && record.decision !== "untrusted") throw new MetadataError("Invalid recovery evidence trust policy binding decision.");
  if (!Number.isFinite(Date.parse(record.evaluatedAt)) || !Number.isFinite(Date.parse(record.boundAt))) {
    throw new MetadataError("Recovery evidence trust policy binding timestamps must be valid.");
  }
}

function assertEvaluationMatchesSnapshot(
  evaluation: RuntimeFleetHandoffRecoveryEvidenceTrustEvaluationRecord,
  snapshot: RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotRecord,
  integrityId: string,
): void {
  validateRuntimeFleetHandoffRecoveryEvidenceTrustEvaluationRecord(evaluation);
  if (
    evaluation.integrityId !== integrityId
    || evaluation.policyId !== snapshot.policyId
    || evaluation.policyVersion !== snapshot.policyVersion
    || evaluation.minimumValidSignatures !== snapshot.policy.minimumValidSignatures
  ) {
    throw new MetadataError(
      `M51 trust evaluation '${evaluation.evaluationId}' does not match policy snapshot '${snapshot.snapshotId}'.`,
    );
  }
}

function identityKey(policyId: string, policyVersion: number): string {
  return `${policyId}\u0000${policyVersion}`;
}

function assertText(value: string, label: string): void {
  if (!value.trim()) throw new MetadataError(`Runtime fleet handoff recovery evidence trust policy ${label} is required.`);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new MetadataError(`Runtime fleet handoff recovery evidence trust policy ${label} must be a positive integer.`);
  }
}
