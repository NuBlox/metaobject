import { ConcurrencyError, MetadataError } from "../errors/errors.js";
import { canonicalizeJson, sha256Hex } from "./runtime-fleet-convergence-handoff-recovery-integrity.js";
import {
  MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureStore,
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureCatalog,
  RuntimeFleetHandoffRecoveryEvidenceSignatureProviderRegistry,
  validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureRecord,
} from "./runtime-fleet-convergence-handoff-recovery-trust-policy-lifecycle-signature.js";
import type {
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureRecord,
} from "./runtime-fleet-convergence-handoff-recovery-trust-policy-lifecycle-signature.js";
import {
  MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustEvaluationStore,
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustCatalog,
  validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustEvaluationRecord,
  validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustPolicy,
} from "./runtime-fleet-convergence-handoff-recovery-trust-policy-lifecycle-signature-trust.js";
import type {
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustEvaluationRecord,
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustPolicyDefinition,
} from "./runtime-fleet-convergence-handoff-recovery-trust-policy-lifecycle-signature-trust.js";
import {
  MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityStore,
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityCatalog,
  validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityRecord,
} from "./runtime-fleet-convergence-handoff-recovery-trust-policy-lifecycle-integrity.js";
import type {
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityRecord,
} from "./runtime-fleet-convergence-handoff-recovery-trust-policy-lifecycle-integrity.js";
import {
  validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleEventRecord,
  validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleRecord,
} from "./runtime-fleet-convergence-handoff-recovery-trust-policy-lifecycle.js";
import type {
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleEventRecord,
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleRecord,
} from "./runtime-fleet-convergence-handoff-recovery-trust-policy-lifecycle.js";
import {
  validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotRecord,
} from "./runtime-fleet-convergence-handoff-recovery-trust-policy-snapshot.js";
import type {
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotRecord,
} from "./runtime-fleet-convergence-handoff-recovery-trust-policy-snapshot.js";

export type RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAlgorithm = "SHA-256";
export type RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleCanonicalization = "nublox-json-canonical-v1";

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleComponentDigests {
  readonly lifecycleState: string;
  readonly lifecycleEvents: string;
  readonly policySnapshots: string;
  readonly lifecycleIntegrity: string;
  readonly lifecycleSignatures: string;
  readonly trustPolicy: string;
  readonly trustEvaluation: string;
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleRecord {
  readonly format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-bundle";
  readonly formatVersion: 1;
  readonly bundleId: string;
  readonly attestationId: string;
  readonly evaluationId: string;
  readonly policyId: string;
  readonly lifecycleRevision: number;
  readonly lifecycleState: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleRecord;
  readonly lifecycleEvents: readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleEventRecord[];
  readonly policySnapshots: readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotRecord[];
  readonly lifecycleIntegrity: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityRecord;
  readonly lifecycleSignatures: readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureRecord[];
  readonly trustPolicy: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustPolicyDefinition;
  readonly trustEvaluation: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustEvaluationRecord;
  readonly algorithm: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAlgorithm;
  readonly canonicalization: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleCanonicalization;
  readonly componentDigests: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleComponentDigests;
  readonly rootDigest: string;
  readonly createdAt: string;
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleFilter {
  readonly attestationId?: string;
  readonly policyId?: string;
  readonly decision?: "trusted" | "untrusted";
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleStore {
  get(bundleId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleRecord | null>;
  list(
    filter?: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleFilter,
  ): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleRecord[]>;
  create(
    record: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleRecord,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleRecord>;
}

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleStore
implements RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleStore {
  readonly #records = new Map<string, RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleRecord>();

  async get(bundleId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleRecord | null> {
    const record = this.#records.get(bundleId);
    return record ? clone(record) : null;
  }

  async list(
    filter: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleFilter = {},
  ): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleRecord[]> {
    return [...this.#records.values()]
      .filter((record) => filter.attestationId === undefined || record.attestationId === filter.attestationId)
      .filter((record) => filter.policyId === undefined || record.policyId === filter.policyId)
      .filter((record) => filter.decision === undefined || record.trustEvaluation.decision === filter.decision)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.bundleId.localeCompare(right.bundleId))
      .map(clone);
  }

  async create(
    record: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleRecord,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleRecord> {
    validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleRecord(record);
    if (this.#records.has(record.bundleId)) {
      throw new ConcurrencyError(`Lifecycle trust bundle '${record.bundleId}' already exists.`);
    }
    const stored = clone(record);
    this.#records.set(stored.bundleId, stored);
    return clone(stored);
  }
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleLifecycleSource {
  history(filter: { readonly policyId?: string }): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleEventRecord[]>;
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleSnapshotSource {
  get(snapshotId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotRecord | null>;
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleIntegritySource {
  get(attestationId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityRecord | null>;
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleSignatureSource {
  history(
    filter: { readonly attestationId?: string },
  ): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureRecord[]>;
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleEvaluationSource {
  get(
    evaluationId: string,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustEvaluationRecord | null>;
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleRequest {
  readonly bundleId: string;
  readonly attestationId: string;
  readonly evaluationId: string;
  readonly trustPolicy: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustPolicyDefinition;
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleVerification {
  readonly bundleId: string;
  readonly valid: boolean;
  readonly componentDigestsMatch: boolean;
  readonly rootDigestMatches: boolean;
  readonly lifecycleIntegrityValid: boolean;
  readonly trustEvaluationMatches: boolean;
  readonly trustDecision: "trusted" | "untrusted";
  readonly expectedRootDigest: string;
  readonly actualRootDigest: string;
  readonly verifiedAt: string;
}

export type RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleClock = () => Date;

/**
 * Freezes the complete evidence required to reproduce one historical M54-M56
 * lifecycle-trust decision. Verification is self-contained except for the
 * caller-supplied public verification providers used by M55.
 */
export class RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleCatalog {
  constructor(
    private readonly lifecycle: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleLifecycleSource,
    private readonly snapshots: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleSnapshotSource,
    private readonly integrity: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleIntegritySource,
    private readonly signatures: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleSignatureSource,
    private readonly evaluations: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleEvaluationSource,
    private readonly providers: RuntimeFleetHandoffRecoveryEvidenceSignatureProviderRegistry,
    private readonly bundles: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleStore,
    private readonly clock: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleClock = () => new Date(),
  ) {}

  async create(
    request: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleRequest,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleRecord> {
    for (const [label, value] of Object.entries({
      bundleId: request.bundleId,
      attestationId: request.attestationId,
      evaluationId: request.evaluationId,
    })) assertText(value, label);
    validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustPolicy(request.trustPolicy);
    if (await this.bundles.get(request.bundleId)) {
      throw new ConcurrencyError(`Lifecycle trust bundle '${request.bundleId}' already exists.`);
    }

    const lifecycleIntegrity = await this.integrity.get(request.attestationId);
    if (!lifecycleIntegrity) {
      throw new MetadataError(`Unknown lifecycle integrity attestation '${request.attestationId}'.`);
    }
    validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityRecord(lifecycleIntegrity);

    const trustEvaluation = await this.evaluations.get(request.evaluationId);
    if (!trustEvaluation) throw new MetadataError(`Unknown lifecycle trust evaluation '${request.evaluationId}'.`);
    validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustEvaluationRecord(trustEvaluation);
    if (trustEvaluation.attestationId !== lifecycleIntegrity.attestationId) {
      throw new MetadataError("Lifecycle trust evaluation does not belong to the requested M54 attestation.");
    }
    if (
      trustEvaluation.policyId !== request.trustPolicy.policyId
      || trustEvaluation.policyVersion !== request.trustPolicy.version
      || trustEvaluation.minimumValidSignatures !== request.trustPolicy.minimumValidSignatures
    ) {
      throw new MetadataError("Lifecycle trust evaluation does not match the supplied trust policy identity/quorum.");
    }

    const allEvents = [...await this.lifecycle.history({ policyId: lifecycleIntegrity.policyId })]
      .filter((event) => event.revision <= lifecycleIntegrity.lifecycleRevision)
      .sort((left, right) => left.revision - right.revision || left.eventId.localeCompare(right.eventId));
    for (const event of allEvents) validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleEventRecord(event);
    const lifecycleState = reconstructLifecycleState(lifecycleIntegrity, allEvents);

    const policySnapshots: RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotRecord[] = [];
    const snapshotIds = [...new Set(allEvents.map((event) => event.snapshotId))];
    for (const snapshotId of snapshotIds) {
      const snapshot = await this.snapshots.get(snapshotId);
      if (!snapshot) throw new MetadataError(`Unknown lifecycle policy snapshot '${snapshotId}'.`);
      validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotRecord(snapshot);
      policySnapshots.push(snapshot);
    }
    policySnapshots.sort((left, right) => left.policyVersion - right.policyVersion || left.snapshotId.localeCompare(right.snapshotId));

    const availableSignatures = [...await this.signatures.history({ attestationId: lifecycleIntegrity.attestationId })];
    const bySignatureId = new Map(availableSignatures.map((record) => [record.signatureId, record] as const));
    const lifecycleSignatures: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureRecord[] = [];
    for (const item of trustEvaluation.signatures) {
      const record = bySignatureId.get(item.signatureId);
      if (!record) throw new MetadataError(`Lifecycle trust evaluation references missing signature '${item.signatureId}'.`);
      validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureRecord(record);
      lifecycleSignatures.push(record);
    }
    lifecycleSignatures.sort((left, right) => left.signerId.localeCompare(right.signerId) || left.signatureId.localeCompare(right.signatureId));

    const componentDigests = await digestBundleComponents({
      lifecycleState,
      lifecycleEvents: allEvents,
      policySnapshots,
      lifecycleIntegrity,
      lifecycleSignatures,
      trustPolicy: request.trustPolicy,
      trustEvaluation,
    });
    const rootDigest = await digestBundleRoot(
      request.bundleId,
      lifecycleIntegrity.attestationId,
      trustEvaluation.evaluationId,
      lifecycleIntegrity.policyId,
      lifecycleIntegrity.lifecycleRevision,
      componentDigests,
    );

    const record: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleRecord = {
      format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-bundle",
      formatVersion: 1,
      bundleId: request.bundleId,
      attestationId: lifecycleIntegrity.attestationId,
      evaluationId: trustEvaluation.evaluationId,
      policyId: lifecycleIntegrity.policyId,
      lifecycleRevision: lifecycleIntegrity.lifecycleRevision,
      lifecycleState: clone(lifecycleState),
      lifecycleEvents: clone(allEvents),
      policySnapshots: clone(policySnapshots),
      lifecycleIntegrity: clone(lifecycleIntegrity),
      lifecycleSignatures: clone(lifecycleSignatures),
      trustPolicy: clone(request.trustPolicy),
      trustEvaluation: clone(trustEvaluation),
      algorithm: "SHA-256",
      canonicalization: "nublox-json-canonical-v1",
      componentDigests,
      rootDigest,
      createdAt: this.clock().toISOString(),
    };

    const verification = await verifyRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundle(
      record,
      this.providers,
      this.clock,
    );
    if (!verification.valid) {
      throw new MetadataError("Lifecycle trust evidence no longer reproduces the recorded M56 decision and cannot be bundled.");
    }
    return this.bundles.create(record);
  }

  async verify(bundleId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleVerification> {
    assertText(bundleId, "bundleId");
    const record = await this.bundles.get(bundleId);
    if (!record) throw new MetadataError(`Unknown lifecycle trust bundle '${bundleId}'.`);
    return verifyRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundle(record, this.providers, this.clock);
  }

  async get(bundleId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleRecord | null> {
    assertText(bundleId, "bundleId");
    return this.bundles.get(bundleId);
  }

  async history(
    filter: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleFilter = {},
  ): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleRecord[]> {
    return this.bundles.list(filter);
  }
}

export async function verifyRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundle(
  record: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleRecord,
  providers: RuntimeFleetHandoffRecoveryEvidenceSignatureProviderRegistry,
  clock: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleClock = () => new Date(),
): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleVerification> {
  validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleRecord(record);

  const actualComponents = await digestBundleComponents(record);
  const componentDigestsMatch = canonicalizeJson(actualComponents) === canonicalizeJson(record.componentDigests);
  const actualRootDigest = await digestBundleRoot(
    record.bundleId,
    record.attestationId,
    record.evaluationId,
    record.policyId,
    record.lifecycleRevision,
    actualComponents,
  );
  const rootDigestMatches = actualRootDigest === record.rootDigest;

  let lifecycleIntegrityValid = false;
  let trustEvaluationMatches = false;
  try {
    const lifecycleSource = {
      async get(policyId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleRecord | null> {
        return policyId === record.lifecycleState.policyId ? clone(record.lifecycleState) : null;
      },
      async history(filter: { readonly policyId?: string } = {}): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleEventRecord[]> {
        return record.lifecycleEvents
          .filter((event) => filter.policyId === undefined || event.policyId === filter.policyId)
          .map(clone);
      },
    };
    const snapshotSource = {
      async get(snapshotId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotRecord | null> {
        const snapshot = record.policySnapshots.find((item) => item.snapshotId === snapshotId);
        return snapshot ? clone(snapshot) : null;
      },
    };
    const integrityStore = new MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityStore();
    await integrityStore.create(record.lifecycleIntegrity);
    const integrityCatalog = new RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityCatalog(
      lifecycleSource,
      snapshotSource,
      integrityStore,
      clock,
    );
    lifecycleIntegrityValid = (await integrityCatalog.verify(record.attestationId)).valid;

    const signatureStore = new MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureStore();
    for (const signature of record.lifecycleSignatures) await signatureStore.create(signature);
    const signatureCatalog = new RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureCatalog(
      integrityCatalog,
      providers,
      signatureStore,
      clock,
    );

    const evaluationStore = new MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustEvaluationStore();
    const evaluationCatalog = new RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustCatalog(
      signatureCatalog,
      evaluationStore,
      () => new Date(record.trustEvaluation.evaluatedAt),
    );
    const derived = await evaluationCatalog.evaluate({
      evaluationId: record.trustEvaluation.evaluationId,
      attestationId: record.attestationId,
      policy: record.trustPolicy,
    });
    trustEvaluationMatches = canonicalizeJson(derived) === canonicalizeJson(record.trustEvaluation);
  } catch {
    lifecycleIntegrityValid = false;
    trustEvaluationMatches = false;
  }

  return {
    bundleId: record.bundleId,
    valid: componentDigestsMatch && rootDigestMatches && lifecycleIntegrityValid && trustEvaluationMatches,
    componentDigestsMatch,
    rootDigestMatches,
    lifecycleIntegrityValid,
    trustEvaluationMatches,
    trustDecision: record.trustEvaluation.decision,
    expectedRootDigest: record.rootDigest,
    actualRootDigest,
    verifiedAt: clock().toISOString(),
  };
}

export function validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleRecord(
  record: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleRecord,
): void {
  if (
    record.format !== "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-bundle"
    || record.formatVersion !== 1
  ) throw new MetadataError("Unsupported lifecycle trust bundle format.");
  for (const [label, value] of Object.entries({
    bundleId: record.bundleId,
    attestationId: record.attestationId,
    evaluationId: record.evaluationId,
    policyId: record.policyId,
    rootDigest: record.rootDigest,
    createdAt: record.createdAt,
  })) assertText(value, label);
  assertPositiveInteger(record.lifecycleRevision, "lifecycleRevision");
  if (record.algorithm !== "SHA-256" || record.canonicalization !== "nublox-json-canonical-v1") {
    throw new MetadataError("Unsupported lifecycle trust bundle digest contract.");
  }
  if (!Number.isFinite(Date.parse(record.createdAt))) throw new MetadataError("Lifecycle trust bundle createdAt must be valid.");
  validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleRecord(record.lifecycleState);
  for (const event of record.lifecycleEvents) validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleEventRecord(event);
  for (const snapshot of record.policySnapshots) validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotRecord(snapshot);
  validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityRecord(record.lifecycleIntegrity);
  for (const signature of record.lifecycleSignatures) validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureRecord(signature);
  validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustPolicy(record.trustPolicy);
  validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustEvaluationRecord(record.trustEvaluation);

  if (
    record.attestationId !== record.lifecycleIntegrity.attestationId
    || record.policyId !== record.lifecycleIntegrity.policyId
    || record.lifecycleRevision !== record.lifecycleIntegrity.lifecycleRevision
    || record.lifecycleState.policyId !== record.policyId
    || record.lifecycleState.revision !== record.lifecycleRevision
  ) throw new MetadataError("Lifecycle trust bundle top-level identity does not match embedded lifecycle evidence.");
  if (
    record.evaluationId !== record.trustEvaluation.evaluationId
    || record.trustEvaluation.attestationId !== record.attestationId
    || record.trustEvaluation.policyId !== record.trustPolicy.policyId
    || record.trustEvaluation.policyVersion !== record.trustPolicy.version
  ) throw new MetadataError("Lifecycle trust bundle evaluation identity does not match its embedded trust policy/evidence.");

  const eventIds = new Set<string>();
  for (const event of record.lifecycleEvents) {
    if (eventIds.has(event.eventId)) throw new MetadataError(`Duplicate lifecycle trust bundle event '${event.eventId}'.`);
    eventIds.add(event.eventId);
  }
  const snapshotIds = new Set<string>();
  for (const snapshot of record.policySnapshots) {
    if (snapshotIds.has(snapshot.snapshotId)) throw new MetadataError(`Duplicate lifecycle trust bundle snapshot '${snapshot.snapshotId}'.`);
    snapshotIds.add(snapshot.snapshotId);
  }
  const signatureIds = new Set<string>();
  for (const signature of record.lifecycleSignatures) {
    if (signatureIds.has(signature.signatureId)) throw new MetadataError(`Duplicate lifecycle trust bundle signature '${signature.signatureId}'.`);
    signatureIds.add(signature.signatureId);
  }
  const evaluationSignatureIds = new Set(record.trustEvaluation.signatures.map((item) => item.signatureId));
  if (
    signatureIds.size !== evaluationSignatureIds.size
    || [...signatureIds].some((signatureId) => !evaluationSignatureIds.has(signatureId))
  ) throw new MetadataError("Lifecycle trust bundle signature set does not match the M56 evaluation evidence set.");

  for (const digest of Object.values(record.componentDigests)) assertDigest(digest, "component digest");
  assertDigest(record.rootDigest, "rootDigest");
}

function reconstructLifecycleState(
  integrity: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityRecord,
  events: readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleEventRecord[],
): RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleRecord {
  if (events.length !== integrity.lifecycleRevision) {
    throw new MetadataError(`Lifecycle history for '${integrity.policyId}' does not contain the attested revision range.`);
  }
  const last = events.at(-1);
  const lastActivate = [...events].reverse().find((event) => event.type === "activate");
  if (!last || !lastActivate) throw new MetadataError(`Lifecycle history for '${integrity.policyId}' cannot reconstruct an active state.`);
  return {
    format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle",
    formatVersion: 1,
    policyId: integrity.policyId,
    revision: integrity.lifecycleRevision,
    status: integrity.lifecycleStatus,
    snapshotId: integrity.snapshotId,
    policyVersion: integrity.policyVersion,
    activatedAt: lastActivate.occurredAt,
    ...(integrity.lifecycleStatus === "retired" ? { retiredAt: last.occurredAt } : {}),
    updatedAt: last.occurredAt,
  };
}

interface BundleComponents {
  readonly lifecycleState: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleRecord;
  readonly lifecycleEvents: readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleEventRecord[];
  readonly policySnapshots: readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotRecord[];
  readonly lifecycleIntegrity: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityRecord;
  readonly lifecycleSignatures: readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureRecord[];
  readonly trustPolicy: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustPolicyDefinition;
  readonly trustEvaluation: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustEvaluationRecord;
}

async function digestBundleComponents(
  components: BundleComponents,
): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleComponentDigests> {
  return {
    lifecycleState: await sha256Hex(canonicalizeJson(components.lifecycleState)),
    lifecycleEvents: await sha256Hex(canonicalizeJson(components.lifecycleEvents)),
    policySnapshots: await sha256Hex(canonicalizeJson(components.policySnapshots)),
    lifecycleIntegrity: await sha256Hex(canonicalizeJson(components.lifecycleIntegrity)),
    lifecycleSignatures: await sha256Hex(canonicalizeJson(components.lifecycleSignatures)),
    trustPolicy: await sha256Hex(canonicalizeJson(components.trustPolicy)),
    trustEvaluation: await sha256Hex(canonicalizeJson(components.trustEvaluation)),
  };
}

async function digestBundleRoot(
  bundleId: string,
  attestationId: string,
  evaluationId: string,
  policyId: string,
  lifecycleRevision: number,
  componentDigests: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleComponentDigests,
): Promise<string> {
  return sha256Hex(canonicalizeJson({
    format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-bundle-root",
    formatVersion: 1,
    algorithm: "SHA-256",
    canonicalization: "nublox-json-canonical-v1",
    bundleId,
    attestationId,
    evaluationId,
    policyId,
    lifecycleRevision,
    componentDigests,
  }));
}

function assertDigest(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new MetadataError(`Lifecycle trust bundle ${label} must be SHA-256 hex.`);
}

function assertText(value: string, label: string): void {
  if (!value.trim()) throw new MetadataError(`Lifecycle trust bundle ${label} is required.`);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new MetadataError(`Lifecycle trust bundle ${label} must be a positive integer.`);
  }
}
