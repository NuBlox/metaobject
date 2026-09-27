import { ConcurrencyError, MetadataError } from "../errors/errors.js";
import {
  digestExternalTrustRoots,
  validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotRecord,
  type RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotRecord,
  type RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotStore,
} from "./runtime-fleet-convergence-handoff-recovery-trust-policy-lifecycle-bundle-anchor-root-snapshot.js";
import {
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceCatalog,
  type RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceState,
} from "./runtime-fleet-convergence-handoff-recovery-trust-policy-lifecycle-bundle-anchor-root-snapshot-governance.js";

export type RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationEventType =
  | "planned"
  | "successor-activated"
  | "predecessor-retired"
  | "completed";

export type RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationStatus =
  | "planned"
  | "successor-active"
  | "predecessor-retired"
  | "completed";

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationEventRecord {
  readonly format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-external-root-rotation-event";
  readonly formatVersion: 1;
  readonly eventId: string;
  readonly rotationId: string;
  readonly predecessorSnapshotId: string;
  readonly predecessorDigest: string;
  readonly successorSnapshotId: string;
  readonly successorDigest: string;
  readonly revision: number;
  readonly type: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationEventType;
  readonly occurredAt: string;
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationState {
  readonly rotationId: string;
  readonly predecessorSnapshotId: string;
  readonly predecessorDigest: string;
  readonly successorSnapshotId: string;
  readonly successorDigest: string;
  readonly revision: number;
  readonly status: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationStatus;
  readonly plannedAt: string;
  readonly successorActivatedAt?: string;
  readonly predecessorRetiredAt?: string;
  readonly completedAt?: string;
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationStore {
  get(eventId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationEventRecord | null>;
  list(rotationId?: string): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationEventRecord[]>;
  create(record: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationEventRecord): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationEventRecord>;
}

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationStore
implements RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationStore {
  readonly #records = new Map<string, RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationEventRecord>();

  async get(eventId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationEventRecord | null> {
    const record = this.#records.get(eventId);
    return record ? clone(record) : null;
  }

  async list(rotationId?: string): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationEventRecord[]> {
    return [...this.#records.values()]
      .filter((record) => rotationId === undefined || record.rotationId === rotationId)
      .sort((a, b) => a.rotationId.localeCompare(b.rotationId) || a.revision - b.revision || a.eventId.localeCompare(b.eventId))
      .map(clone);
  }

  async create(record: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationEventRecord): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationEventRecord> {
    validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationEventRecord(record);
    if (this.#records.has(record.eventId)) {
      throw new ConcurrencyError(`External trust root rotation event '${record.eventId}' already exists.`);
    }
    const stored = clone(record);
    this.#records.set(stored.eventId, stored);
    return clone(stored);
  }
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationRequest {
  readonly rotationId: string;
  readonly predecessorSnapshotId: string;
  readonly successorSnapshotId: string;
}

export type RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationClock = () => Date;

export class RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationCatalog {
  constructor(
    private readonly snapshots: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotStore,
    private readonly governance: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceCatalog,
    private readonly rotations: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationStore,
    private readonly clock: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationClock = () => new Date(),
  ) {}

  async rotate(
    request: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationRequest,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationState> {
    validateRequest(request);
    const existing = await this.getState(request.rotationId);
    if (!existing) {
      await this.plan(request);
    } else if (
      existing.predecessorSnapshotId !== request.predecessorSnapshotId
      || existing.successorSnapshotId !== request.successorSnapshotId
    ) {
      throw new ConcurrencyError(`External trust root rotation '${request.rotationId}' is already bound to another snapshot pair.`);
    }
    return this.resume(request.rotationId);
  }

  async plan(
    request: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationRequest,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationState> {
    validateRequest(request);
    if (request.predecessorSnapshotId === request.successorSnapshotId) {
      throw new MetadataError("External trust root rotation requires distinct predecessor and successor snapshots.");
    }
    if (await this.getState(request.rotationId)) {
      throw new ConcurrencyError(`External trust root rotation '${request.rotationId}' already exists.`);
    }

    const predecessor = await this.requireValidSnapshot(request.predecessorSnapshotId);
    const successor = await this.requireValidSnapshot(request.successorSnapshotId);
    const predecessorState = await this.governance.getState(predecessor.snapshotId);
    if (!predecessorState || predecessorState.status !== "active") {
      throw new MetadataError(`External trust root rotation predecessor '${predecessor.snapshotId}' must be active.`);
    }
    if (await this.governance.getState(successor.snapshotId)) {
      throw new MetadataError(`External trust root rotation successor '${successor.snapshotId}' must not already be governed.`);
    }

    await this.assertPairAvailable(request);
    await this.rotations.create(this.event(
      request.rotationId,
      predecessor,
      successor,
      1,
      "planned",
      `${request.rotationId}:planned`,
    ));
    return this.requireState(request.rotationId);
  }

  async resume(rotationId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationState> {
    assertText(rotationId, "rotationId");
    let state = await this.requireState(rotationId);
    const predecessor = await this.requireValidSnapshot(state.predecessorSnapshotId);
    const successor = await this.requireValidSnapshot(state.successorSnapshotId);
    this.assertFrozenDigests(state, predecessor, successor);

    if (state.status === "completed") return state;

    if (state.status === "planned") {
      await this.ensureSuccessorActivation(state);
      await this.appendStage(state, "successor-activated", `${rotationId}:successor-activated`);
      state = await this.requireState(rotationId);
    }

    if (state.status === "successor-active") {
      await this.ensurePredecessorRetirement(state);
      await this.appendStage(state, "predecessor-retired", `${rotationId}:predecessor-retired`);
      state = await this.requireState(rotationId);
    }

    if (state.status === "predecessor-retired") {
      await this.appendStage(state, "completed", `${rotationId}:completed`);
      state = await this.requireState(rotationId);
    }

    return state;
  }

  async getState(rotationId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationState | null> {
    assertText(rotationId, "rotationId");
    const events = await this.rotations.list(rotationId);
    if (events.length === 0) return null;
    return replayRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotation(rotationId, events);
  }

  async history(rotationId?: string): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationEventRecord[]> {
    if (rotationId !== undefined) assertText(rotationId, "rotationId");
    return this.rotations.list(rotationId);
  }

  private async ensureSuccessorActivation(
    state: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationState,
  ): Promise<void> {
    const eventId = `${state.rotationId}:m60:activate-successor`;
    const successorState = await this.governance.getState(state.successorSnapshotId);
    if (!successorState) {
      await this.governance.activate(eventId, state.successorSnapshotId);
      return;
    }
    if (successorState.status !== "active" || !(await this.hasGovernanceEvent(state.successorSnapshotId, eventId, "activated"))) {
      throw new MetadataError(`External trust root rotation '${state.rotationId}' successor governance does not match this rotation.`);
    }
  }

  private async ensurePredecessorRetirement(
    state: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationState,
  ): Promise<void> {
    const eventId = `${state.rotationId}:m60:retire-predecessor`;
    const predecessorState = await this.requireGovernanceState(state.predecessorSnapshotId);
    if (predecessorState.status === "active") {
      await this.governance.retire({
        eventId,
        snapshotId: state.predecessorSnapshotId,
        expectedRevision: predecessorState.revision,
        reason: `Superseded by '${state.successorSnapshotId}' through rotation '${state.rotationId}'.`,
      });
      return;
    }
    if (predecessorState.status !== "retired" || !(await this.hasGovernanceEvent(state.predecessorSnapshotId, eventId, "retired"))) {
      throw new MetadataError(`External trust root rotation '${state.rotationId}' predecessor governance does not match this rotation.`);
    }
  }

  private async hasGovernanceEvent(snapshotId: string, eventId: string, type: "activated" | "retired"): Promise<boolean> {
    const history = await this.governance.history(snapshotId);
    return history.some((event) => event.eventId === eventId && event.type === type);
  }

  private async requireGovernanceState(
    snapshotId: string,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceState> {
    const state = await this.governance.getState(snapshotId);
    if (!state) throw new MetadataError(`External trust root snapshot '${snapshotId}' has no governance state.`);
    return state;
  }

  private async appendStage(
    state: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationState,
    type: Exclude<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationEventType, "planned">,
    eventId: string,
  ): Promise<void> {
    await this.rotations.create({
      format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-external-root-rotation-event",
      formatVersion: 1,
      eventId,
      rotationId: state.rotationId,
      predecessorSnapshotId: state.predecessorSnapshotId,
      predecessorDigest: state.predecessorDigest,
      successorSnapshotId: state.successorSnapshotId,
      successorDigest: state.successorDigest,
      revision: state.revision + 1,
      type,
      occurredAt: this.clock().toISOString(),
    });
  }

  private event(
    rotationId: string,
    predecessor: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotRecord,
    successor: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotRecord,
    revision: number,
    type: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationEventType,
    eventId: string,
  ): RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationEventRecord {
    return {
      format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-external-root-rotation-event",
      formatVersion: 1,
      eventId,
      rotationId,
      predecessorSnapshotId: predecessor.snapshotId,
      predecessorDigest: predecessor.rootDigest,
      successorSnapshotId: successor.snapshotId,
      successorDigest: successor.rootDigest,
      revision,
      type,
      occurredAt: this.clock().toISOString(),
    };
  }

  private async assertPairAvailable(
    request: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationRequest,
  ): Promise<void> {
    const events = await this.rotations.list();
    for (const event of events) {
      if (event.type !== "planned") continue;
      if (event.predecessorSnapshotId === request.predecessorSnapshotId) {
        throw new ConcurrencyError(`External trust root snapshot '${request.predecessorSnapshotId}' already has a recorded successor.`);
      }
      if (event.successorSnapshotId === request.successorSnapshotId) {
        throw new ConcurrencyError(`External trust root snapshot '${request.successorSnapshotId}' is already the successor of another rotation.`);
      }
    }
  }

  private assertFrozenDigests(
    state: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationState,
    predecessor: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotRecord,
    successor: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotRecord,
  ): void {
    if (predecessor.rootDigest !== state.predecessorDigest || successor.rootDigest !== state.successorDigest) {
      throw new MetadataError(`External trust root rotation '${state.rotationId}' snapshot digest no longer matches its frozen plan.`);
    }
  }

  private async requireState(rotationId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationState> {
    const state = await this.getState(rotationId);
    if (!state) throw new MetadataError(`Unknown external trust root rotation '${rotationId}'.`);
    return state;
  }

  private async requireValidSnapshot(
    snapshotId: string,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotRecord> {
    const snapshot = await this.snapshots.get(snapshotId);
    if (!snapshot) throw new MetadataError(`Unknown external trust root snapshot '${snapshotId}'.`);
    validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotRecord(snapshot);
    if (await digestExternalTrustRoots(snapshot.roots) !== snapshot.rootDigest) {
      throw new MetadataError(`External trust root snapshot '${snapshotId}' is invalid.`);
    }
    return snapshot;
  }
}

export function replayRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotation(
  rotationId: string,
  events: readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationEventRecord[],
): RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationState {
  assertText(rotationId, "rotationId");
  if (events.length === 0) throw new MetadataError(`External trust root rotation '${rotationId}' has no events.`);

  const ordered = [...events].sort((a, b) => a.revision - b.revision || a.eventId.localeCompare(b.eventId));
  const expectedTypes: readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationEventType[] = [
    "planned",
    "successor-activated",
    "predecessor-retired",
    "completed",
  ];
  let state: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationState | null = null;
  let frozenIdentity: Pick<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationEventRecord,
    "predecessorSnapshotId" | "predecessorDigest" | "successorSnapshotId" | "successorDigest"> | null = null;
  let previousOccurredAt: number | undefined;

  for (const [index, event] of ordered.entries()) {
    validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationEventRecord(event);
    const occurredAt = Date.parse(event.occurredAt);
    if (previousOccurredAt !== undefined && occurredAt < previousOccurredAt) {
      throw new MetadataError(`External trust root rotation '${rotationId}' event timestamps are not monotonic.`);
    }
    previousOccurredAt = occurredAt;
    if (event.rotationId !== rotationId) throw new MetadataError(`External trust root rotation event '${event.eventId}' belongs to another rotation.`);
    const expectedRevision = index + 1;
    if (event.revision !== expectedRevision || event.type !== expectedTypes[index]) {
      throw new MetadataError(`External trust root rotation '${rotationId}' event sequence is invalid.`);
    }

    if (!frozenIdentity) {
      frozenIdentity = {
        predecessorSnapshotId: event.predecessorSnapshotId,
        predecessorDigest: event.predecessorDigest,
        successorSnapshotId: event.successorSnapshotId,
        successorDigest: event.successorDigest,
      };
    } else if (
      event.predecessorSnapshotId !== frozenIdentity.predecessorSnapshotId
      || event.predecessorDigest !== frozenIdentity.predecessorDigest
      || event.successorSnapshotId !== frozenIdentity.successorSnapshotId
      || event.successorDigest !== frozenIdentity.successorDigest
    ) {
      throw new MetadataError(`External trust root rotation '${rotationId}' frozen snapshot identity changed.`);
    }

    if (event.type === "planned") {
      state = {
        rotationId,
        ...frozenIdentity,
        revision: event.revision,
        status: "planned",
        plannedAt: event.occurredAt,
      };
      continue;
    }
    if (!state) throw new MetadataError(`External trust root rotation '${rotationId}' must be planned first.`);
    if (event.type === "successor-activated") {
      state = { ...state, revision: event.revision, status: "successor-active", successorActivatedAt: event.occurredAt };
    } else if (event.type === "predecessor-retired") {
      state = { ...state, revision: event.revision, status: "predecessor-retired", predecessorRetiredAt: event.occurredAt };
    } else {
      state = { ...state, revision: event.revision, status: "completed", completedAt: event.occurredAt };
    }
  }

  if (!state) throw new MetadataError(`External trust root rotation '${rotationId}' replay produced no state.`);
  return state;
}

export function validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationEventRecord(
  record: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationEventRecord,
): void {
  if (
    record.format !== "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-external-root-rotation-event"
    || record.formatVersion !== 1
  ) {
    throw new MetadataError("Unsupported external trust root rotation event format.");
  }
  for (const [label, value] of Object.entries({
    eventId: record.eventId,
    rotationId: record.rotationId,
    predecessorSnapshotId: record.predecessorSnapshotId,
    predecessorDigest: record.predecessorDigest,
    successorSnapshotId: record.successorSnapshotId,
    successorDigest: record.successorDigest,
  })) assertText(value, label);
  assertRevision(record.revision);
  if (!(["planned", "successor-activated", "predecessor-retired", "completed"] as const).includes(record.type)) {
    throw new MetadataError(`Unsupported external trust root rotation event type '${record.type}'.`);
  }
  if (!Number.isFinite(Date.parse(record.occurredAt))) throw new MetadataError("External trust root rotation occurredAt must be valid.");
}

function validateRequest(request: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationRequest): void {
  assertText(request.rotationId, "rotationId");
  assertText(request.predecessorSnapshotId, "predecessorSnapshotId");
  assertText(request.successorSnapshotId, "successorSnapshotId");
}

function assertText(value: string, label: string): void {
  if (!value.trim()) throw new MetadataError(`External trust root rotation ${label} is required.`);
}

function assertRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new MetadataError("External trust root rotation revision must be a positive safe integer.");
}
