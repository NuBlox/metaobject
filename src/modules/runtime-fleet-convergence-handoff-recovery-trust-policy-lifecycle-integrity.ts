import { ConcurrencyError, MetadataError } from "../errors/errors.js";
import { canonicalizeJson, sha256Hex } from "./runtime-fleet-convergence-handoff-recovery-integrity.js";
import type {
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotRecord,
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotStore,
} from "./runtime-fleet-convergence-handoff-recovery-trust-policy-snapshot.js";
import {
  digestTrustPolicy,
  validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotRecord,
} from "./runtime-fleet-convergence-handoff-recovery-trust-policy-snapshot.js";
import type {
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleEventRecord,
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleRecord,
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleStatus,
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleStore,
} from "./runtime-fleet-convergence-handoff-recovery-trust-policy-lifecycle.js";
import {
  validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleEventRecord,
  validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleRecord,
} from "./runtime-fleet-convergence-handoff-recovery-trust-policy-lifecycle.js";

export type RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityAlgorithm = "SHA-256";
export type RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityCanonicalization = "nublox-json-canonical-v1";

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleEventDigest {
  readonly eventId: string;
  readonly revision: number;
  readonly type: "activate" | "retire";
  readonly snapshotId: string;
  readonly policyVersion: number;
  readonly digest: string;
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSnapshotDigest {
  readonly snapshotId: string;
  readonly policyVersion: number;
  readonly policyDigest: string;
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityRecord {
  readonly format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-integrity";
  readonly formatVersion: 1;
  readonly attestationId: string;
  readonly policyId: string;
  readonly lifecycleRevision: number;
  readonly lifecycleStatus: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleStatus;
  readonly snapshotId: string;
  readonly policyVersion: number;
  readonly algorithm: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityAlgorithm;
  readonly canonicalization: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityCanonicalization;
  readonly events: readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleEventDigest[];
  readonly snapshots: readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSnapshotDigest[];
  readonly currentStateDigest: string;
  readonly rootDigest: string;
  readonly createdAt: string;
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityFilter {
  readonly policyId?: string;
  readonly lifecycleStatus?: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleStatus;
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityStore {
  get(attestationId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityRecord | null>;
  list(
    filter?: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityFilter,
  ): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityRecord[]>;
  create(
    record: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityRecord,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityRecord>;
}

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityStore
implements RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityStore {
  readonly #records = new Map<string, RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityRecord>();

  async get(attestationId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityRecord | null> {
    const record = this.#records.get(attestationId);
    return record ? clone(record) : null;
  }

  async list(
    filter: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityFilter = {},
  ): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityRecord[]> {
    return [...this.#records.values()]
      .filter((record) => filter.policyId === undefined || record.policyId === filter.policyId)
      .filter((record) => filter.lifecycleStatus === undefined || record.lifecycleStatus === filter.lifecycleStatus)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.attestationId.localeCompare(right.attestationId))
      .map(clone);
  }

  async create(
    record: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityRecord,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityRecord> {
    validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityRecord(record);
    if (this.#records.has(record.attestationId)) {
      throw new ConcurrencyError(`Recovery evidence trust policy lifecycle integrity '${record.attestationId}' already exists.`);
    }
    const stored = clone(record);
    this.#records.set(stored.attestationId, stored);
    return clone(stored);
  }
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityRequest {
  readonly attestationId: string;
  readonly policyId: string;
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityVerification {
  readonly attestationId: string;
  readonly valid: boolean;
  readonly chainValid: boolean;
  readonly eventsMatch: boolean;
  readonly snapshotsMatch: boolean;
  readonly currentStateMatches: boolean;
  readonly rootDigestMatches: boolean;
  readonly expectedRootDigest: string;
  readonly actualRootDigest: string;
  readonly verifiedAt: string;
}

export type RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityClock = () => Date;

/**
 * Creates immutable tamper evidence over the complete M53 lifecycle for one
 * policy. The event stream is semantically validated before any digest is
 * trusted: revisions must be contiguous, transitions legal, snapshots exact,
 * and the current lifecycle state derivable from the final event.
 */
export class RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityCatalog {
  constructor(
    private readonly lifecycle: Pick<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleStore, "get" | "history">,
    private readonly snapshots: Pick<RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotStore, "get">,
    private readonly integrity: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityStore,
    private readonly clock: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityClock = () => new Date(),
  ) {}

  async create(
    request: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityRequest,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityRecord> {
    assertText(request.attestationId, "attestationId");
    assertText(request.policyId, "policyId");
    if (await this.integrity.get(request.attestationId)) {
      throw new ConcurrencyError(`Recovery evidence trust policy lifecycle integrity '${request.attestationId}' already exists.`);
    }

    const evidence = await this.loadAndValidate(request.policyId);
    const digests = await digestEvidence(evidence.current, evidence.events, evidence.snapshots);
    return this.integrity.create({
      format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-integrity",
      formatVersion: 1,
      attestationId: request.attestationId,
      policyId: evidence.current.policyId,
      lifecycleRevision: evidence.current.revision,
      lifecycleStatus: evidence.current.status,
      snapshotId: evidence.current.snapshotId,
      policyVersion: evidence.current.policyVersion,
      algorithm: "SHA-256",
      canonicalization: "nublox-json-canonical-v1",
      events: digests.events,
      snapshots: digests.snapshots,
      currentStateDigest: digests.currentStateDigest,
      rootDigest: digests.rootDigest,
      createdAt: this.clock().toISOString(),
    });
  }

  async verify(
    attestationId: string,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityVerification> {
    assertText(attestationId, "attestationId");
    const record = await this.integrity.get(attestationId);
    if (!record) throw new MetadataError(`Unknown recovery evidence trust policy lifecycle integrity '${attestationId}'.`);
    validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityRecord(record);

    let evidence: LifecycleEvidence;
    try {
      evidence = await this.loadAndValidate(record.policyId);
    } catch {
      return {
        attestationId: record.attestationId,
        valid: false,
        chainValid: false,
        eventsMatch: false,
        snapshotsMatch: false,
        currentStateMatches: false,
        rootDigestMatches: false,
        expectedRootDigest: record.rootDigest,
        actualRootDigest: "",
        verifiedAt: this.clock().toISOString(),
      };
    }

    const actual = await digestEvidence(evidence.current, evidence.events, evidence.snapshots);
    const eventsMatch = canonicalizeJson(record.events) === canonicalizeJson(actual.events);
    const snapshotsMatch = canonicalizeJson(record.snapshots) === canonicalizeJson(actual.snapshots);
    const currentStateMatches = record.lifecycleRevision === evidence.current.revision
      && record.lifecycleStatus === evidence.current.status
      && record.snapshotId === evidence.current.snapshotId
      && record.policyVersion === evidence.current.policyVersion
      && record.currentStateDigest === actual.currentStateDigest;
    const rootDigestMatches = record.rootDigest === actual.rootDigest;

    return {
      attestationId: record.attestationId,
      valid: eventsMatch && snapshotsMatch && currentStateMatches && rootDigestMatches,
      chainValid: true,
      eventsMatch,
      snapshotsMatch,
      currentStateMatches,
      rootDigestMatches,
      expectedRootDigest: record.rootDigest,
      actualRootDigest: actual.rootDigest,
      verifiedAt: this.clock().toISOString(),
    };
  }

  async get(
    attestationId: string,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityRecord | null> {
    assertText(attestationId, "attestationId");
    return this.integrity.get(attestationId);
  }

  async history(
    filter: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityFilter = {},
  ): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityRecord[]> {
    return this.integrity.list(filter);
  }

  private async loadAndValidate(policyId: string): Promise<LifecycleEvidence> {
    const current = await this.lifecycle.get(policyId);
    if (!current) throw new MetadataError(`Recovery evidence trust policy '${policyId}' has no lifecycle record.`);
    validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleRecord(current);

    const events = [...await this.lifecycle.history({ policyId })]
      .sort((left, right) => left.revision - right.revision || left.eventId.localeCompare(right.eventId));
    for (const event of events) validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleEventRecord(event);
    validateLifecycleChain(current, events);

    const snapshots = await this.loadSnapshots(policyId, events);
    return { current, events, snapshots };
  }

  private async loadSnapshots(
    policyId: string,
    events: readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleEventRecord[],
  ): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotRecord[]> {
    const seen = new Map<string, RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotRecord>();
    for (const event of events) {
      if (seen.has(event.snapshotId)) continue;
      const snapshot = await this.snapshots.get(event.snapshotId);
      if (!snapshot) throw new MetadataError(`Unknown recovery evidence trust policy snapshot '${event.snapshotId}'.`);
      validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotRecord(snapshot);
      if (snapshot.policyId !== policyId || snapshot.policyVersion !== event.policyVersion) {
        throw new MetadataError(`Lifecycle event '${event.eventId}' does not match M52 snapshot '${event.snapshotId}'.`);
      }
      const actualPolicyDigest = await digestTrustPolicy(snapshot.policy);
      if (actualPolicyDigest !== snapshot.policyDigest) {
        throw new MetadataError(`M52 snapshot '${snapshot.snapshotId}' policy digest is invalid.`);
      }
      seen.set(snapshot.snapshotId, snapshot);
    }
    return [...seen.values()].sort((left, right) => left.policyVersion - right.policyVersion || left.snapshotId.localeCompare(right.snapshotId));
  }
}

interface LifecycleEvidence {
  readonly current: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleRecord;
  readonly events: readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleEventRecord[];
  readonly snapshots: readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotRecord[];
}

interface LifecycleDigests {
  readonly events: readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleEventDigest[];
  readonly snapshots: readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSnapshotDigest[];
  readonly currentStateDigest: string;
  readonly rootDigest: string;
}

function validateLifecycleChain(
  current: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleRecord,
  events: readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleEventRecord[],
): void {
  if (events.length !== current.revision) {
    throw new MetadataError(`Recovery evidence trust policy '${current.policyId}' lifecycle history is incomplete.`);
  }

  let priorSnapshotId: string | undefined;
  let priorPolicyVersion: number | undefined;
  let priorStatus: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleStatus | undefined;
  let lastActivationAt: string | undefined;
  let priorOccurredAt: string | undefined;

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    const expectedRevision = index + 1;
    if (event.policyId !== current.policyId || event.revision !== expectedRevision) {
      throw new MetadataError(`Recovery evidence trust policy '${current.policyId}' lifecycle revisions are not contiguous.`);
    }
    if (priorOccurredAt !== undefined && event.occurredAt < priorOccurredAt) {
      throw new MetadataError(`Recovery evidence trust policy '${current.policyId}' lifecycle timestamps are not monotonic.`);
    }

    if (event.type === "activate") {
      if (expectedRevision === 1) {
        if (event.previousSnapshotId !== undefined || event.previousPolicyVersion !== undefined) {
          throw new MetadataError("Initial recovery evidence trust policy activation cannot declare previous snapshot state.");
        }
      } else {
        if (
          priorSnapshotId === undefined
          || priorPolicyVersion === undefined
          || event.previousSnapshotId !== priorSnapshotId
          || event.previousPolicyVersion !== priorPolicyVersion
        ) {
          throw new MetadataError(`Activation event '${event.eventId}' does not continue the prior lifecycle state.`);
        }
        if (event.policyVersion <= priorPolicyVersion) {
          throw new MetadataError(`Activation event '${event.eventId}' must advance policy version.`);
        }
      }
      priorSnapshotId = event.snapshotId;
      priorPolicyVersion = event.policyVersion;
      priorStatus = "active";
      lastActivationAt = event.occurredAt;
    } else {
      if (expectedRevision === 1 || priorStatus !== "active" || priorSnapshotId === undefined || priorPolicyVersion === undefined) {
        throw new MetadataError(`Retirement event '${event.eventId}' has no active policy state to retire.`);
      }
      if (
        event.snapshotId !== priorSnapshotId
        || event.policyVersion !== priorPolicyVersion
        || event.previousSnapshotId !== priorSnapshotId
        || event.previousPolicyVersion !== priorPolicyVersion
      ) {
        throw new MetadataError(`Retirement event '${event.eventId}' does not match the active lifecycle state.`);
      }
      priorStatus = "retired";
    }
    priorOccurredAt = event.occurredAt;
  }

  const last = events.at(-1);
  if (!last || priorSnapshotId === undefined || priorPolicyVersion === undefined || priorStatus === undefined || lastActivationAt === undefined) {
    throw new MetadataError(`Recovery evidence trust policy '${current.policyId}' lifecycle history is empty.`);
  }
  if (
    current.revision !== last.revision
    || current.status !== priorStatus
    || current.snapshotId !== priorSnapshotId
    || current.policyVersion !== priorPolicyVersion
    || current.activatedAt !== lastActivationAt
    || current.updatedAt !== last.occurredAt
  ) {
    throw new MetadataError(`Recovery evidence trust policy '${current.policyId}' current state is not derivable from lifecycle history.`);
  }
  if (current.status === "retired") {
    if (last.type !== "retire" || current.retiredAt !== last.occurredAt) {
      throw new MetadataError(`Retired recovery evidence trust policy '${current.policyId}' does not match its final retirement event.`);
    }
  } else if (current.retiredAt !== undefined) {
    throw new MetadataError(`Active recovery evidence trust policy '${current.policyId}' cannot retain retiredAt.`);
  }
}

async function digestEvidence(
  current: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleRecord,
  events: readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleEventRecord[],
  snapshots: readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotRecord[],
): Promise<LifecycleDigests> {
  const eventDigests: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleEventDigest[] = [];
  for (const event of events) {
    eventDigests.push({
      eventId: event.eventId,
      revision: event.revision,
      type: event.type,
      snapshotId: event.snapshotId,
      policyVersion: event.policyVersion,
      digest: await sha256Hex(canonicalizeJson(event)),
    });
  }
  const snapshotDigests = snapshots.map((snapshot) => ({
    snapshotId: snapshot.snapshotId,
    policyVersion: snapshot.policyVersion,
    policyDigest: snapshot.policyDigest,
  }));
  const currentStateDigest = await sha256Hex(canonicalizeJson(current));
  const rootDigest = await sha256Hex(canonicalizeJson({
    format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-root",
    formatVersion: 1,
    algorithm: "SHA-256",
    canonicalization: "nublox-json-canonical-v1",
    policyId: current.policyId,
    lifecycleRevision: current.revision,
    lifecycleStatus: current.status,
    events: eventDigests,
    snapshots: snapshotDigests,
    currentStateDigest,
  }));
  return { events: eventDigests, snapshots: snapshotDigests, currentStateDigest, rootDigest };
}

export function validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityRecord(
  record: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityRecord,
): void {
  if (
    record.format !== "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-integrity"
    || record.formatVersion !== 1
  ) throw new MetadataError("Unsupported recovery evidence trust policy lifecycle integrity format.");
  for (const [label, value] of Object.entries({
    attestationId: record.attestationId,
    policyId: record.policyId,
    snapshotId: record.snapshotId,
    currentStateDigest: record.currentStateDigest,
    rootDigest: record.rootDigest,
    createdAt: record.createdAt,
  })) assertText(value, label);
  assertPositiveInteger(record.lifecycleRevision, "lifecycleRevision");
  assertPositiveInteger(record.policyVersion, "policyVersion");
  if (record.lifecycleStatus !== "active" && record.lifecycleStatus !== "retired") {
    throw new MetadataError("Invalid recovery evidence trust policy lifecycle integrity status.");
  }
  if (record.algorithm !== "SHA-256" || record.canonicalization !== "nublox-json-canonical-v1") {
    throw new MetadataError("Unsupported recovery evidence trust policy lifecycle integrity algorithm/canonicalization.");
  }
  if (!Number.isFinite(Date.parse(record.createdAt))) {
    throw new MetadataError("Recovery evidence trust policy lifecycle integrity createdAt must be a valid timestamp.");
  }
  if (record.events.length !== record.lifecycleRevision) {
    throw new MetadataError("Recovery evidence trust policy lifecycle integrity event count must equal lifecycleRevision.");
  }
  const eventIds = new Set<string>();
  for (let index = 0; index < record.events.length; index += 1) {
    const event = record.events[index]!;
    assertText(event.eventId, "eventId");
    assertText(event.snapshotId, "event snapshotId");
    assertDigest(event.digest, "event digest");
    assertPositiveInteger(event.revision, "event revision");
    assertPositiveInteger(event.policyVersion, "event policyVersion");
    if (event.revision !== index + 1) throw new MetadataError("Lifecycle integrity event revisions must be contiguous and ordered.");
    if (event.type !== "activate" && event.type !== "retire") throw new MetadataError("Invalid lifecycle integrity event type.");
    if (eventIds.has(event.eventId)) throw new MetadataError(`Duplicate lifecycle integrity event '${event.eventId}'.`);
    eventIds.add(event.eventId);
  }
  const snapshotIds = new Set<string>();
  for (const snapshot of record.snapshots) {
    assertText(snapshot.snapshotId, "snapshotId");
    assertPositiveInteger(snapshot.policyVersion, "snapshot policyVersion");
    assertDigest(snapshot.policyDigest, "snapshot policyDigest");
    if (snapshotIds.has(snapshot.snapshotId)) throw new MetadataError(`Duplicate lifecycle integrity snapshot '${snapshot.snapshotId}'.`);
    snapshotIds.add(snapshot.snapshotId);
  }
  if (!snapshotIds.has(record.snapshotId)) {
    throw new MetadataError("Lifecycle integrity current snapshot must be represented in snapshot digests.");
  }
  assertDigest(record.currentStateDigest, "currentStateDigest");
  assertDigest(record.rootDigest, "rootDigest");
}

function assertDigest(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new MetadataError(`Recovery evidence trust policy lifecycle integrity ${label} must be a SHA-256 hex digest.`);
}

function assertText(value: string, label: string): void {
  if (!value.trim()) throw new MetadataError(`Recovery evidence trust policy lifecycle integrity ${label} is required.`);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new MetadataError(`Recovery evidence trust policy lifecycle integrity ${label} must be a positive integer.`);
}
