import { ConcurrencyError, MetadataError } from "../errors/errors.js";
import { canonicalizeJson, sha256Hex } from "./runtime-fleet-convergence-handoff-recovery-integrity.js";
import type { RuntimeFleetHandoffRecoveryEvidenceSignatureMaterial } from "./runtime-fleet-convergence-handoff-recovery-signature.js";
import { RuntimeFleetHandoffRecoveryEvidenceSignatureProviderRegistry } from "./runtime-fleet-convergence-handoff-recovery-signature.js";
import type {
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleRecord,
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleVerification,
} from "./runtime-fleet-convergence-handoff-recovery-trust-policy-lifecycle-bundle.js";
import { validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleRecord } from "./runtime-fleet-convergence-handoff-recovery-trust-policy-lifecycle-bundle.js";

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRecord {
  readonly format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-bundle-anchor";
  readonly formatVersion: 1;
  readonly anchorId: string;
  readonly bundleId: string;
  readonly attestationId: string;
  readonly evaluationId: string;
  readonly policyId: string;
  readonly lifecycleRevision: number;
  readonly bundleRootDigest: string;
  readonly bundleAlgorithm: "SHA-256";
  readonly bundleCanonicalization: "nublox-json-canonical-v1";
  readonly authorityId: string;
  readonly algorithm: string;
  readonly keyId: string;
  readonly signature: string;
  readonly payloadDigest: string;
  readonly anchoredAt: string;
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorFilter {
  readonly bundleId?: string;
  readonly authorityId?: string;
  readonly keyId?: string;
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorStore {
  get(anchorId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRecord | null>;
  list(
    filter?: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorFilter,
  ): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRecord[]>;
  create(
    record: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRecord,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRecord>;
}

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorStore
implements RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorStore {
  readonly #records = new Map<string, RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRecord>();

  async get(anchorId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRecord | null> {
    const record = this.#records.get(anchorId);
    return record ? clone(record) : null;
  }

  async list(
    filter: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorFilter = {},
  ): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRecord[]> {
    return [...this.#records.values()]
      .filter((record) => filter.bundleId === undefined || record.bundleId === filter.bundleId)
      .filter((record) => filter.authorityId === undefined || record.authorityId === filter.authorityId)
      .filter((record) => filter.keyId === undefined || record.keyId === filter.keyId)
      .sort((left, right) => left.anchoredAt.localeCompare(right.anchoredAt) || left.anchorId.localeCompare(right.anchorId))
      .map(clone);
  }

  async create(
    record: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRecord,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRecord> {
    validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRecord(record);
    if (this.#records.has(record.anchorId)) {
      throw new ConcurrencyError(`Lifecycle trust bundle anchor '${record.anchorId}' already exists.`);
    }
    const stored = clone(record);
    this.#records.set(stored.anchorId, stored);
    return clone(stored);
  }
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorBundleSource {
  get(bundleId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleRecord | null>;
  verify(bundleId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleVerification>;
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRequest {
  readonly anchorId: string;
  readonly bundleId: string;
  readonly authorityId: string;
}

/**
 * External trust roots are supplied out-of-band at verification time. They are
 * intentionally not persisted or governed by another package-internal policy
 * lifecycle, making this the recursion stop for the in-package trust chain.
 */
export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRoot {
  readonly authorityId: string;
  readonly allowedAlgorithms?: readonly string[];
  readonly allowedKeyIds?: readonly string[];
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorVerification {
  readonly anchorId: string;
  readonly valid: boolean;
  readonly bundleValid: boolean;
  readonly payloadMatches: boolean;
  readonly authorityTrusted: boolean;
  readonly signatureValid: boolean;
  readonly verifiedAt: string;
}

export type RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorClock = () => Date;

/**
 * Signs one exact M57 bundle root with an externally managed authority and
 * verifies it against caller-supplied out-of-band trust roots.
 */
export class RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorCatalog {
  constructor(
    private readonly bundles: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorBundleSource,
    private readonly providers: RuntimeFleetHandoffRecoveryEvidenceSignatureProviderRegistry,
    private readonly anchors: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorStore,
    private readonly clock: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorClock = () => new Date(),
  ) {}

  async anchor(
    request: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRequest,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRecord> {
    assertText(request.anchorId, "anchorId");
    assertText(request.bundleId, "bundleId");
    assertText(request.authorityId, "authorityId");
    if (await this.anchors.get(request.anchorId)) {
      throw new ConcurrencyError(`Lifecycle trust bundle anchor '${request.anchorId}' already exists.`);
    }

    const before = await this.requireBundle(request.bundleId);
    const verification = await this.bundles.verify(before.bundleId);
    if (!verification.valid) {
      throw new MetadataError(`Lifecycle trust bundle '${before.bundleId}' is invalid and cannot be externally anchored.`);
    }

    const payload = lifecycleBundleAnchorPayload(before);
    const provider = this.providers.get(request.authorityId);
    const material = await provider.sign(payload);
    validateMaterial(material);

    const after = await this.requireBundle(request.bundleId);
    if (!sameBundleIdentity(before, after)) {
      throw new ConcurrencyError(`Lifecycle trust bundle '${request.bundleId}' changed while its external anchor was being created.`);
    }

    return this.anchors.create({
      format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-bundle-anchor",
      formatVersion: 1,
      anchorId: request.anchorId,
      bundleId: before.bundleId,
      attestationId: before.attestationId,
      evaluationId: before.evaluationId,
      policyId: before.policyId,
      lifecycleRevision: before.lifecycleRevision,
      bundleRootDigest: before.rootDigest,
      bundleAlgorithm: before.algorithm,
      bundleCanonicalization: before.canonicalization,
      authorityId: provider.signerId,
      algorithm: material.algorithm,
      keyId: material.keyId,
      signature: material.signature,
      payloadDigest: await sha256Hex(payload),
      anchoredAt: this.clock().toISOString(),
    });
  }

  async verify(
    anchorId: string,
    trustedRoots: readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRoot[],
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorVerification> {
    assertText(anchorId, "anchorId");
    validateTrustedRoots(trustedRoots);
    const anchor = await this.anchors.get(anchorId);
    if (!anchor) throw new MetadataError(`Unknown lifecycle trust bundle anchor '${anchorId}'.`);
    validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRecord(anchor);

    const bundle = await this.requireBundle(anchor.bundleId);
    let bundleValid = false;
    try {
      bundleValid = (await this.bundles.verify(bundle.bundleId)).valid;
    } catch {
      bundleValid = false;
    }

    const payload = lifecycleBundleAnchorPayload(bundle);
    const payloadDigest = await sha256Hex(payload);
    const payloadMatches = anchor.attestationId === bundle.attestationId
      && anchor.evaluationId === bundle.evaluationId
      && anchor.policyId === bundle.policyId
      && anchor.lifecycleRevision === bundle.lifecycleRevision
      && anchor.bundleRootDigest === bundle.rootDigest
      && anchor.bundleAlgorithm === bundle.algorithm
      && anchor.bundleCanonicalization === bundle.canonicalization
      && anchor.payloadDigest === payloadDigest;

    const root = trustedRoots.find((item) => item.authorityId === anchor.authorityId);
    const authorityTrusted = root !== undefined
      && (root.allowedAlgorithms === undefined || root.allowedAlgorithms.includes(anchor.algorithm))
      && (root.allowedKeyIds === undefined || root.allowedKeyIds.includes(anchor.keyId));

    let signatureValid = false;
    if (payloadMatches) {
      try {
        const provider = this.providers.get(anchor.authorityId);
        signatureValid = await provider.verify(payload, {
          algorithm: anchor.algorithm,
          keyId: anchor.keyId,
          signature: anchor.signature,
        });
      } catch {
        signatureValid = false;
      }
    }

    return {
      anchorId: anchor.anchorId,
      valid: bundleValid && payloadMatches && authorityTrusted && signatureValid,
      bundleValid,
      payloadMatches,
      authorityTrusted,
      signatureValid,
      verifiedAt: this.clock().toISOString(),
    };
  }

  async get(anchorId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRecord | null> {
    assertText(anchorId, "anchorId");
    return this.anchors.get(anchorId);
  }

  async history(
    filter: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorFilter = {},
  ): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRecord[]> {
    return this.anchors.list(filter);
  }

  private async requireBundle(bundleId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleRecord> {
    const bundle = await this.bundles.get(bundleId);
    if (!bundle) throw new MetadataError(`Unknown lifecycle trust bundle '${bundleId}'.`);
    validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleRecord(bundle);
    return bundle;
  }
}

export function lifecycleBundleAnchorPayload(
  bundle: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleRecord,
): string {
  validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleRecord(bundle);
  return canonicalizeJson({
    format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-bundle-anchor-payload",
    formatVersion: 1,
    bundleId: bundle.bundleId,
    attestationId: bundle.attestationId,
    evaluationId: bundle.evaluationId,
    policyId: bundle.policyId,
    lifecycleRevision: bundle.lifecycleRevision,
    bundleRootDigest: bundle.rootDigest,
    bundleAlgorithm: bundle.algorithm,
    bundleCanonicalization: bundle.canonicalization,
  });
}

export function validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRecord(
  record: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRecord,
): void {
  if (
    record.format !== "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-bundle-anchor"
    || record.formatVersion !== 1
  ) throw new MetadataError("Unsupported lifecycle trust bundle anchor format.");
  for (const [label, value] of Object.entries({
    anchorId: record.anchorId,
    bundleId: record.bundleId,
    attestationId: record.attestationId,
    evaluationId: record.evaluationId,
    policyId: record.policyId,
    bundleRootDigest: record.bundleRootDigest,
    authorityId: record.authorityId,
    algorithm: record.algorithm,
    keyId: record.keyId,
    signature: record.signature,
    payloadDigest: record.payloadDigest,
    anchoredAt: record.anchoredAt,
  })) assertText(value, label);
  assertPositiveInteger(record.lifecycleRevision, "lifecycleRevision");
  assertDigest(record.bundleRootDigest, "bundleRootDigest");
  assertDigest(record.payloadDigest, "payloadDigest");
  if (record.bundleAlgorithm !== "SHA-256" || record.bundleCanonicalization !== "nublox-json-canonical-v1") {
    throw new MetadataError("Unsupported lifecycle trust bundle anchor digest contract.");
  }
  if (!Number.isFinite(Date.parse(record.anchoredAt))) {
    throw new MetadataError("Lifecycle trust bundle anchor anchoredAt must be valid.");
  }
}

function sameBundleIdentity(
  left: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleRecord,
  right: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleRecord,
): boolean {
  return left.bundleId === right.bundleId
    && left.attestationId === right.attestationId
    && left.evaluationId === right.evaluationId
    && left.policyId === right.policyId
    && left.lifecycleRevision === right.lifecycleRevision
    && left.rootDigest === right.rootDigest
    && left.algorithm === right.algorithm
    && left.canonicalization === right.canonicalization;
}

function validateTrustedRoots(
  roots: readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRoot[],
): void {
  if (roots.length === 0) throw new MetadataError("At least one external lifecycle trust root is required.");
  const ids = new Set<string>();
  for (const root of roots) {
    assertText(root.authorityId, "trusted root authorityId");
    if (ids.has(root.authorityId)) throw new MetadataError(`Duplicate external lifecycle trust root '${root.authorityId}'.`);
    ids.add(root.authorityId);
    validateTextList(root.allowedAlgorithms, `allowedAlgorithms for '${root.authorityId}'`);
    validateTextList(root.allowedKeyIds, `allowedKeyIds for '${root.authorityId}'`);
  }
}

function validateMaterial(material: RuntimeFleetHandoffRecoveryEvidenceSignatureMaterial): void {
  assertText(material.algorithm, "algorithm");
  assertText(material.keyId, "keyId");
  assertText(material.signature, "signature");
}

function validateTextList(values: readonly string[] | undefined, label: string): void {
  if (values === undefined) return;
  if (values.length === 0) throw new MetadataError(`Lifecycle trust bundle anchor ${label} cannot be empty when supplied.`);
  const seen = new Set<string>();
  for (const value of values) {
    assertText(value, label);
    if (seen.has(value)) throw new MetadataError(`Lifecycle trust bundle anchor ${label} contains duplicate '${value}'.`);
    seen.add(value);
  }
}

function assertDigest(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new MetadataError(`Lifecycle trust bundle anchor ${label} must be SHA-256 hex.`);
}

function assertText(value: string, label: string): void {
  if (!value.trim()) throw new MetadataError(`Lifecycle trust bundle anchor ${label} is required.`);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new MetadataError(`Lifecycle trust bundle anchor ${label} must be a positive integer.`);
  }
}
