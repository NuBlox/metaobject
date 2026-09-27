import { ConcurrencyError, MetadataError } from "../errors/errors.js";
import { canonicalizeJson, sha256Hex } from "./runtime-fleet-convergence-handoff-recovery-integrity.js";
import type {
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorVerification,
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRoot,
} from "./runtime-fleet-convergence-handoff-recovery-trust-policy-lifecycle-bundle-anchor.js";

export type RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotAlgorithm = "SHA-256";
export type RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotCanonicalization = "nublox-json-canonical-v1";

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotRecord {
  readonly format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-external-root-snapshot";
  readonly formatVersion: 1;
  readonly snapshotId: string;
  readonly roots: readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRoot[];
  readonly rootDigest: string;
  readonly algorithm: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotAlgorithm;
  readonly canonicalization: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotCanonicalization;
  readonly publishedAt: string;
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotStore {
  get(snapshotId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotRecord | null>;
  list(): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotRecord[]>;
  create(record: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotRecord): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotRecord>;
}

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotStore
implements RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotStore {
  readonly #records = new Map<string, RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotRecord>();

  async get(snapshotId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotRecord | null> {
    const record = this.#records.get(snapshotId);
    return record ? clone(record) : null;
  }

  async list(): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotRecord[]> {
    return [...this.#records.values()]
      .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt) || a.snapshotId.localeCompare(b.snapshotId))
      .map(clone);
  }

  async create(record: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotRecord): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotRecord> {
    validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotRecord(record);
    if (this.#records.has(record.snapshotId)) {
      throw new ConcurrencyError(`External trust root snapshot '${record.snapshotId}' already exists.`);
    }
    const stored = clone(record);
    this.#records.set(stored.snapshotId, stored);
    return clone(stored);
  }
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotPublishRequest {
  readonly snapshotId: string;
  readonly roots: readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRoot[];
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotVerification {
  readonly snapshotId: string;
  readonly valid: boolean;
  readonly digestMatches: boolean;
  readonly verifiedAt: string;
}

export type RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotClock = () => Date;

export class RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotCatalog {
  constructor(
    private readonly snapshots: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotStore,
    private readonly clock: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotClock = () => new Date(),
  ) {}

  async publish(request: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotPublishRequest): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotRecord> {
    assertText(request.snapshotId, "snapshotId");
    const roots = normalizeRoots(request.roots);
    if (await this.snapshots.get(request.snapshotId)) {
      throw new ConcurrencyError(`External trust root snapshot '${request.snapshotId}' already exists.`);
    }
    return this.snapshots.create({
      format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-external-root-snapshot",
      formatVersion: 1,
      snapshotId: request.snapshotId,
      roots,
      rootDigest: await digestExternalTrustRoots(roots),
      algorithm: "SHA-256",
      canonicalization: "nublox-json-canonical-v1",
      publishedAt: this.clock().toISOString(),
    });
  }

  async verify(snapshotId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotVerification> {
    assertText(snapshotId, "snapshotId");
    const record = await this.snapshots.get(snapshotId);
    if (!record) throw new MetadataError(`Unknown external trust root snapshot '${snapshotId}'.`);
    let digestMatches = false;
    try {
      validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotRecord(record);
      digestMatches = await digestExternalTrustRoots(record.roots) === record.rootDigest;
    } catch {
      digestMatches = false;
    }
    return { snapshotId, valid: digestMatches, digestMatches, verifiedAt: this.clock().toISOString() };
  }

  async get(snapshotId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotRecord | null> {
    assertText(snapshotId, "snapshotId");
    return this.snapshots.get(snapshotId);
  }

  async history(): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotRecord[]> {
    return this.snapshots.list();
  }
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRootBindingRecord {
  readonly format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-bundle-anchor-root-binding";
  readonly formatVersion: 1;
  readonly bindingId: string;
  readonly anchorId: string;
  readonly snapshotId: string;
  readonly snapshotDigest: string;
  readonly anchorValid: boolean;
  readonly authorityTrusted: boolean;
  readonly signatureValid: boolean;
  readonly boundAt: string;
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRootBindingStore {
  get(bindingId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRootBindingRecord | null>;
  list(): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRootBindingRecord[]>;
  create(record: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRootBindingRecord): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRootBindingRecord>;
}

export class MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRootBindingStore
implements RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRootBindingStore {
  readonly #records = new Map<string, RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRootBindingRecord>();
  async get(bindingId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRootBindingRecord | null> {
    const record = this.#records.get(bindingId);
    return record ? clone(record) : null;
  }
  async list(): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRootBindingRecord[]> {
    return [...this.#records.values()].sort((a, b) => a.boundAt.localeCompare(b.boundAt) || a.bindingId.localeCompare(b.bindingId)).map(clone);
  }
  async create(record: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRootBindingRecord): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRootBindingRecord> {
    validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRootBindingRecord(record);
    if (this.#records.has(record.bindingId)) throw new ConcurrencyError(`External trust root binding '${record.bindingId}' already exists.`);
    const stored = clone(record);
    this.#records.set(stored.bindingId, stored);
    return clone(stored);
  }
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorVerificationSource {
  verify(anchorId: string, roots: readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRoot[]): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorVerification>;
}

export class RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRootBoundCatalog {
  constructor(
    private readonly snapshots: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotStore,
    private readonly anchors: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorVerificationSource,
    private readonly bindings: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRootBindingStore,
    private readonly clock: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotClock = () => new Date(),
  ) {}

  async verifyAndBind(bindingId: string, anchorId: string, snapshotId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRootBindingRecord> {
    for (const [label, value] of Object.entries({ bindingId, anchorId, snapshotId })) assertText(value, label);
    if (await this.bindings.get(bindingId)) throw new ConcurrencyError(`External trust root binding '${bindingId}' already exists.`);
    const snapshot = await this.snapshots.get(snapshotId);
    if (!snapshot) throw new MetadataError(`Unknown external trust root snapshot '${snapshotId}'.`);
    validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotRecord(snapshot);
    if (await digestExternalTrustRoots(snapshot.roots) !== snapshot.rootDigest) {
      throw new MetadataError(`External trust root snapshot '${snapshotId}' is invalid.`);
    }
    const verification = await this.anchors.verify(anchorId, snapshot.roots);
    return this.bindings.create({
      format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-bundle-anchor-root-binding",
      formatVersion: 1,
      bindingId,
      anchorId,
      snapshotId,
      snapshotDigest: snapshot.rootDigest,
      anchorValid: verification.valid,
      authorityTrusted: verification.authorityTrusted,
      signatureValid: verification.signatureValid,
      boundAt: this.clock().toISOString(),
    });
  }

  async get(bindingId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRootBindingRecord | null> {
    assertText(bindingId, "bindingId");
    return this.bindings.get(bindingId);
  }

  async history(): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRootBindingRecord[]> {
    return this.bindings.list();
  }
}

export async function digestExternalTrustRoots(roots: readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRoot[]): Promise<string> {
  const normalized = normalizeRoots(roots);
  return sha256Hex(canonicalizeJson({
    format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-external-root-snapshot-payload",
    formatVersion: 1,
    roots: normalized,
  }));
}

export function validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotRecord(record: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotRecord): void {
  if (record.format !== "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-external-root-snapshot" || record.formatVersion !== 1) {
    throw new MetadataError("Unsupported external trust root snapshot format.");
  }
  assertText(record.snapshotId, "snapshotId");
  assertDigest(record.rootDigest, "rootDigest");
  if (record.algorithm !== "SHA-256" || record.canonicalization !== "nublox-json-canonical-v1") throw new MetadataError("Unsupported external trust root snapshot digest contract.");
  if (!Number.isFinite(Date.parse(record.publishedAt))) throw new MetadataError("External trust root snapshot publishedAt must be valid.");
  normalizeRoots(record.roots);
}

export function validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRootBindingRecord(record: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRootBindingRecord): void {
  if (record.format !== "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-bundle-anchor-root-binding" || record.formatVersion !== 1) throw new MetadataError("Unsupported external trust root binding format.");
  for (const [label, value] of Object.entries({ bindingId: record.bindingId, anchorId: record.anchorId, snapshotId: record.snapshotId, boundAt: record.boundAt })) assertText(value, label);
  assertDigest(record.snapshotDigest, "snapshotDigest");
  if (!Number.isFinite(Date.parse(record.boundAt))) throw new MetadataError("External trust root binding boundAt must be valid.");
}

function normalizeRoots(roots: readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRoot[]): readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRoot[] {
  if (roots.length === 0) throw new MetadataError("At least one external trust root is required.");
  const ids = new Set<string>();
  return roots.map((root) => {
    assertText(root.authorityId, "authorityId");
    if (ids.has(root.authorityId)) throw new MetadataError(`Duplicate external trust root '${root.authorityId}'.`);
    ids.add(root.authorityId);
    const allowedAlgorithms = normalizeTextList(root.allowedAlgorithms, `allowedAlgorithms for '${root.authorityId}'`);
    const allowedKeyIds = normalizeTextList(root.allowedKeyIds, `allowedKeyIds for '${root.authorityId}'`);
    return {
      authorityId: root.authorityId,
      ...(allowedAlgorithms === undefined ? {} : { allowedAlgorithms }),
      ...(allowedKeyIds === undefined ? {} : { allowedKeyIds }),
    };
  }).sort((a, b) => a.authorityId.localeCompare(b.authorityId));
}

function normalizeTextList(values: readonly string[] | undefined, label: string): readonly string[] | undefined {
  if (values === undefined) return undefined;
  if (values.length === 0) throw new MetadataError(`${label} cannot be empty when supplied.`);
  const normalized = [...values].sort();
  for (const value of normalized) assertText(value, label);
  for (let i = 1; i < normalized.length; i += 1) {
    if (normalized[i] === normalized[i - 1]) throw new MetadataError(`${label} contains duplicate '${normalized[i]}'.`);
  }
  return normalized;
}

function assertText(value: string, label: string): void {
  if (!value.trim()) throw new MetadataError(`External trust root snapshot ${label} is required.`);
}

function assertDigest(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new MetadataError(`External trust root snapshot ${label} must be SHA-256 hex.`);
}
