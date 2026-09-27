import { ConcurrencyError, MetadataError } from "../errors/errors.js";
import type {
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyBoundRecord,
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyBoundRequest,
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotRecord,
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotStore,
} from "./runtime-fleet-convergence-handoff-recovery-trust-policy-snapshot.js";
import {
  validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotRecord,
} from "./runtime-fleet-convergence-handoff-recovery-trust-policy-snapshot.js";

export type RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleStatus = "active" | "retired";
export type RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleEventType = "activate" | "retire";

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleRecord {
  readonly format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle";
  readonly formatVersion: 1;
  readonly policyId: string;
  readonly revision: number;
  readonly status: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleStatus;
  readonly snapshotId: string;
  readonly policyVersion: number;
  readonly activatedAt: string;
  readonly retiredAt?: string;
  readonly updatedAt: string;
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleEventRecord {
  readonly format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-event";
  readonly formatVersion: 1;
  readonly eventId: string;
  readonly policyId: string;
  readonly revision: number;
  readonly type: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleEventType;
  readonly snapshotId: string;
  readonly policyVersion: number;
  readonly previousSnapshotId?: string;
  readonly previousPolicyVersion?: number;
  readonly actorId: string;
  readonly reason?: string;
  readonly occurredAt: string;
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleEventFilter {
  readonly policyId?: string;
  readonly type?: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleEventType;
  readonly actorId?: string;
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleStore {
  get(policyId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleRecord | null>;
  history(
    filter?: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleEventFilter,
  ): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleEventRecord[]>;
  commit(
    record: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleRecord,
    event: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleEventRecord,
    expectedRevision: number,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleRecord>;
}

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleStore
implements RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleStore {
  readonly #records = new Map<string, RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleRecord>();
  readonly #events = new Map<string, RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleEventRecord>();

  async get(policyId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleRecord | null> {
    const record = this.#records.get(policyId);
    return record ? clone(record) : null;
  }

  async history(
    filter: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleEventFilter = {},
  ): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleEventRecord[]> {
    return [...this.#events.values()]
      .filter((event) => filter.policyId === undefined || event.policyId === filter.policyId)
      .filter((event) => filter.type === undefined || event.type === filter.type)
      .filter((event) => filter.actorId === undefined || event.actorId === filter.actorId)
      .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.eventId.localeCompare(right.eventId))
      .map(clone);
  }

  async commit(
    record: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleRecord,
    event: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleEventRecord,
    expectedRevision: number,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleRecord> {
    validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleRecord(record);
    validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleEventRecord(event);
    assertCommitMatchesEvent(record, event);
    assertNonNegativeInteger(expectedRevision, "expectedRevision");

    const current = this.#records.get(record.policyId);
    const actualRevision = current?.revision ?? 0;
    if (actualRevision !== expectedRevision) {
      throw new ConcurrencyError(
        `Recovery evidence trust policy '${record.policyId}' revision is ${actualRevision}; expected ${expectedRevision}.`,
      );
    }
    if (record.revision !== expectedRevision + 1) {
      throw new ConcurrencyError(
        `Recovery evidence trust policy '${record.policyId}' next revision must be ${expectedRevision + 1}.`,
      );
    }
    if (this.#events.has(event.eventId)) {
      throw new ConcurrencyError(`Recovery evidence trust policy lifecycle event '${event.eventId}' already exists.`);
    }

    const storedRecord = clone(record);
    const storedEvent = clone(event);
    this.#records.set(storedRecord.policyId, storedRecord);
    this.#events.set(storedEvent.eventId, storedEvent);
    return clone(storedRecord);
  }
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyActivationRequest {
  readonly eventId: string;
  readonly snapshotId: string;
  readonly expectedRevision: number;
  readonly actorId: string;
  readonly reason?: string;
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyRetirementRequest {
  readonly eventId: string;
  readonly policyId: string;
  readonly expectedRevision: number;
  readonly actorId: string;
  readonly reason?: string;
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyCurrentEvaluationRequest {
  readonly bindingId: string;
  readonly evaluationId: string;
  readonly integrityId: string;
  readonly policyId: string;
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyBoundEvaluationSource {
  evaluate(
    request: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyBoundRequest,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyBoundRecord>;
}

export type RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleClock = () => Date;

/**
 * Governs which immutable M52 policy snapshot is authoritative for new trust
 * decisions. Historical snapshots and bindings remain immutable and readable.
 */
export class RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleCatalog {
  constructor(
    private readonly snapshots: RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotStore,
    private readonly lifecycle: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleStore,
    private readonly boundTrust: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyBoundEvaluationSource,
    private readonly clock: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleClock = () => new Date(),
  ) {}

  async activate(
    request: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyActivationRequest,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleRecord> {
    assertText(request.eventId, "eventId");
    assertText(request.snapshotId, "snapshotId");
    assertText(request.actorId, "actorId");
    validateOptionalReason(request.reason);
    assertNonNegativeInteger(request.expectedRevision, "expectedRevision");

    const snapshot = await this.requireSnapshot(request.snapshotId);
    const current = await this.lifecycle.get(snapshot.policyId);
    const actualRevision = current?.revision ?? 0;
    if (actualRevision !== request.expectedRevision) {
      throw new ConcurrencyError(
        `Recovery evidence trust policy '${snapshot.policyId}' revision is ${actualRevision}; expected ${request.expectedRevision}.`,
      );
    }
    if (current && snapshot.policyVersion <= current.policyVersion) {
      throw new MetadataError(
        `Recovery evidence trust policy '${snapshot.policyId}' activation must advance beyond version ${current.policyVersion}.`,
      );
    }

    const now = this.clock().toISOString();
    const revision = actualRevision + 1;
    const record: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleRecord = {
      format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle",
      formatVersion: 1,
      policyId: snapshot.policyId,
      revision,
      status: "active",
      snapshotId: snapshot.snapshotId,
      policyVersion: snapshot.policyVersion,
      activatedAt: now,
      updatedAt: now,
    };
    const event: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleEventRecord = {
      format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-event",
      formatVersion: 1,
      eventId: request.eventId,
      policyId: snapshot.policyId,
      revision,
      type: "activate",
      snapshotId: snapshot.snapshotId,
      policyVersion: snapshot.policyVersion,
      ...(current ? {
        previousSnapshotId: current.snapshotId,
        previousPolicyVersion: current.policyVersion,
      } : {}),
      actorId: request.actorId,
      ...(request.reason === undefined ? {} : { reason: request.reason }),
      occurredAt: now,
    };
    return this.lifecycle.commit(record, event, request.expectedRevision);
  }

  async retire(
    request: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyRetirementRequest,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleRecord> {
    assertText(request.eventId, "eventId");
    assertText(request.policyId, "policyId");
    assertText(request.actorId, "actorId");
    validateOptionalReason(request.reason);
    assertNonNegativeInteger(request.expectedRevision, "expectedRevision");

    const current = await this.lifecycle.get(request.policyId);
    if (!current) throw new MetadataError(`Unknown recovery evidence trust policy lifecycle '${request.policyId}'.`);
    if (current.revision !== request.expectedRevision) {
      throw new ConcurrencyError(
        `Recovery evidence trust policy '${request.policyId}' revision is ${current.revision}; expected ${request.expectedRevision}.`,
      );
    }
    if (current.status !== "active") {
      throw new MetadataError(`Recovery evidence trust policy '${request.policyId}' is already retired.`);
    }

    const now = this.clock().toISOString();
    const revision = current.revision + 1;
    const record: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleRecord = {
      ...current,
      revision,
      status: "retired",
      retiredAt: now,
      updatedAt: now,
    };
    const event: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleEventRecord = {
      format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-event",
      formatVersion: 1,
      eventId: request.eventId,
      policyId: current.policyId,
      revision,
      type: "retire",
      snapshotId: current.snapshotId,
      policyVersion: current.policyVersion,
      previousSnapshotId: current.snapshotId,
      previousPolicyVersion: current.policyVersion,
      actorId: request.actorId,
      ...(request.reason === undefined ? {} : { reason: request.reason }),
      occurredAt: now,
    };
    return this.lifecycle.commit(record, event, request.expectedRevision);
  }

  async current(policyId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleRecord | null> {
    assertText(policyId, "policyId");
    return this.lifecycle.get(policyId);
  }

  async resolveActive(
    policyId: string,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotRecord> {
    assertText(policyId, "policyId");
    const current = await this.lifecycle.get(policyId);
    if (!current) throw new MetadataError(`Recovery evidence trust policy '${policyId}' has no lifecycle record.`);
    validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleRecord(current);
    if (current.status !== "active") {
      throw new MetadataError(`Recovery evidence trust policy '${policyId}' is retired and cannot authorize new trust evaluations.`);
    }
    const snapshot = await this.requireSnapshot(current.snapshotId);
    if (
      snapshot.policyId !== current.policyId
      || snapshot.policyVersion !== current.policyVersion
    ) {
      throw new MetadataError(`Active recovery evidence trust policy '${policyId}' no longer matches its M52 snapshot.`);
    }
    return snapshot;
  }

  async evaluateCurrent(
    request: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyCurrentEvaluationRequest,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyBoundRecord> {
    for (const [label, value] of Object.entries({
      bindingId: request.bindingId,
      evaluationId: request.evaluationId,
      integrityId: request.integrityId,
      policyId: request.policyId,
    })) assertText(value, label);
    const snapshot = await this.resolveActive(request.policyId);
    return this.boundTrust.evaluate({
      bindingId: request.bindingId,
      evaluationId: request.evaluationId,
      integrityId: request.integrityId,
      snapshotId: snapshot.snapshotId,
    });
  }

  async history(
    filter: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleEventFilter = {},
  ): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleEventRecord[]> {
    return this.lifecycle.history(filter);
  }

  private async requireSnapshot(snapshotId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotRecord> {
    const snapshot = await this.snapshots.get(snapshotId);
    if (!snapshot) throw new MetadataError(`Unknown recovery evidence trust policy snapshot '${snapshotId}'.`);
    validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotRecord(snapshot);
    return snapshot;
  }
}

export function validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleRecord(
  record: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleRecord,
): void {
  if (
    record.format !== "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle"
    || record.formatVersion !== 1
  ) throw new MetadataError("Unsupported recovery evidence trust policy lifecycle format.");
  for (const [label, value] of Object.entries({
    policyId: record.policyId,
    snapshotId: record.snapshotId,
    activatedAt: record.activatedAt,
    updatedAt: record.updatedAt,
  })) assertText(value, label);
  assertPositiveInteger(record.revision, "revision");
  assertPositiveInteger(record.policyVersion, "policyVersion");
  if (record.status !== "active" && record.status !== "retired") {
    throw new MetadataError("Invalid recovery evidence trust policy lifecycle status.");
  }
  if (!Number.isFinite(Date.parse(record.activatedAt)) || !Number.isFinite(Date.parse(record.updatedAt))) {
    throw new MetadataError("Recovery evidence trust policy lifecycle timestamps must be valid.");
  }
  if (record.status === "active" && record.retiredAt !== undefined) {
    throw new MetadataError("Active recovery evidence trust policy cannot have retiredAt.");
  }
  if (record.status === "retired") {
    if (record.retiredAt === undefined || !Number.isFinite(Date.parse(record.retiredAt))) {
      throw new MetadataError("Retired recovery evidence trust policy requires a valid retiredAt timestamp.");
    }
  }
}

export function validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleEventRecord(
  event: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleEventRecord,
): void {
  if (
    event.format !== "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-event"
    || event.formatVersion !== 1
  ) throw new MetadataError("Unsupported recovery evidence trust policy lifecycle event format.");
  for (const [label, value] of Object.entries({
    eventId: event.eventId,
    policyId: event.policyId,
    snapshotId: event.snapshotId,
    actorId: event.actorId,
    occurredAt: event.occurredAt,
  })) assertText(value, label);
  assertPositiveInteger(event.revision, "event revision");
  assertPositiveInteger(event.policyVersion, "event policyVersion");
  if (event.type !== "activate" && event.type !== "retire") {
    throw new MetadataError("Invalid recovery evidence trust policy lifecycle event type.");
  }
  if (!Number.isFinite(Date.parse(event.occurredAt))) {
    throw new MetadataError("Recovery evidence trust policy lifecycle event occurredAt must be valid.");
  }
  if ((event.previousSnapshotId === undefined) !== (event.previousPolicyVersion === undefined)) {
    throw new MetadataError("Recovery evidence trust policy lifecycle previous snapshot identity must be supplied together.");
  }
  if (event.previousSnapshotId !== undefined) {
    assertText(event.previousSnapshotId, "previousSnapshotId");
    assertPositiveInteger(event.previousPolicyVersion as number, "previousPolicyVersion");
  }
  validateOptionalReason(event.reason);
}

function assertCommitMatchesEvent(
  record: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleRecord,
  event: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleEventRecord,
): void {
  if (
    record.policyId !== event.policyId
    || record.revision !== event.revision
    || record.snapshotId !== event.snapshotId
    || record.policyVersion !== event.policyVersion
  ) {
    throw new MetadataError("Recovery evidence trust policy lifecycle record does not match its immutable event.");
  }
  if (event.type === "activate" && record.status !== "active") {
    throw new MetadataError("Trust policy activate event must commit active state.");
  }
  if (event.type === "retire" && record.status !== "retired") {
    throw new MetadataError("Trust policy retire event must commit retired state.");
  }
}

function validateOptionalReason(reason: string | undefined): void {
  if (reason !== undefined) assertText(reason, "reason");
}

function assertText(value: string, label: string): void {
  if (!value.trim()) throw new MetadataError(`Runtime fleet handoff recovery evidence trust policy lifecycle ${label} is required.`);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new MetadataError(`Runtime fleet handoff recovery evidence trust policy lifecycle ${label} must be a positive integer.`);
  }
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MetadataError(`Runtime fleet handoff recovery evidence trust policy lifecycle ${label} must be a non-negative integer.`);
  }
}
