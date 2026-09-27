import { ConcurrencyError, MetadataError } from "../errors/errors.js";
import {
  digestExternalTrustRoots,
  validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotRecord,
  type RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRootBindingRecord,
  type RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotStore,
} from "./runtime-fleet-convergence-handoff-recovery-trust-policy-lifecycle-bundle-anchor-root-snapshot.js";

export type RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceStatus =
  | "active"
  | "retired"
  | "revoked";

export type RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceEventType =
  | "activated"
  | "retired"
  | "revoked";

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceEventRecord {
  readonly format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-external-root-snapshot-governance-event";
  readonly formatVersion: 1;
  readonly eventId: string;
  readonly snapshotId: string;
  readonly revision: number;
  readonly type: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceEventType;
  readonly reason?: string;
  readonly occurredAt: string;
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceState {
  readonly snapshotId: string;
  readonly status: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceStatus;
  readonly revision: number;
  readonly activatedAt: string;
  readonly retiredAt?: string;
  readonly revokedAt?: string;
  readonly reason?: string;
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceStore {
  get(eventId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceEventRecord | null>;
  list(snapshotId?: string): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceEventRecord[]>;
  create(record: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceEventRecord): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceEventRecord>;
}

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceStore
implements RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceStore {
  readonly #records = new Map<string, RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceEventRecord>();

  async get(eventId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceEventRecord | null> {
    const record = this.#records.get(eventId);
    return record ? clone(record) : null;
  }

  async list(snapshotId?: string): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceEventRecord[]> {
    return [...this.#records.values()]
      .filter((record) => snapshotId === undefined || record.snapshotId === snapshotId)
      .sort((a, b) => a.snapshotId.localeCompare(b.snapshotId) || a.revision - b.revision || a.eventId.localeCompare(b.eventId))
      .map(clone);
  }

  async create(record: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceEventRecord): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceEventRecord> {
    validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceEventRecord(record);
    if (this.#records.has(record.eventId)) {
      throw new ConcurrencyError(`External trust root snapshot governance event '${record.eventId}' already exists.`);
    }
    const stored = clone(record);
    this.#records.set(stored.eventId, stored);
    return clone(stored);
  }
}

export type RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceClock = () => Date;

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceTransitionRequest {
  readonly eventId: string;
  readonly snapshotId: string;
  readonly expectedRevision: number;
  readonly reason?: string;
}

export class RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceCatalog {
  constructor(
    private readonly snapshots: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotStore,
    private readonly governance: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceStore,
    private readonly clock: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceClock = () => new Date(),
  ) {}

  async activate(
    eventId: string,
    snapshotId: string,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceState> {
    assertText(eventId, "eventId");
    assertText(snapshotId, "snapshotId");
    const snapshot = await this.requireValidSnapshot(snapshotId);
    const current = await this.getState(snapshotId);
    if (current) throw new MetadataError(`External trust root snapshot '${snapshotId}' is already governed.`);

    await this.governance.create({
      format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-external-root-snapshot-governance-event",
      formatVersion: 1,
      eventId,
      snapshotId: snapshot.snapshotId,
      revision: 1,
      type: "activated",
      occurredAt: this.clock().toISOString(),
    });
    return this.requireState(snapshotId);
  }

  async retire(
    request: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceTransitionRequest,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceState> {
    return this.transition(request, "retired");
  }

  async revoke(
    request: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceTransitionRequest,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceState> {
    return this.transition(request, "revoked");
  }

  async getState(snapshotId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceState | null> {
    assertText(snapshotId, "snapshotId");
    const events = await this.governance.list(snapshotId);
    if (events.length === 0) return null;
    return replayRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernance(snapshotId, events);
  }

  async history(snapshotId?: string): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceEventRecord[]> {
    if (snapshotId !== undefined) assertText(snapshotId, "snapshotId");
    return this.governance.list(snapshotId);
  }

  async assertActive(snapshotId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceState> {
    await this.requireValidSnapshot(snapshotId);
    const state = await this.requireState(snapshotId);
    if (state.status !== "active") {
      throw new MetadataError(`External trust root snapshot '${snapshotId}' is ${state.status} and cannot authorize a new anchor binding.`);
    }
    return state;
  }

  private async transition(
    request: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceTransitionRequest,
    type: "retired" | "revoked",
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceState> {
    assertText(request.eventId, "eventId");
    assertText(request.snapshotId, "snapshotId");
    assertRevision(request.expectedRevision, "expectedRevision");
    if (request.reason !== undefined) assertText(request.reason, "reason");

    await this.requireValidSnapshot(request.snapshotId);
    const current = await this.requireState(request.snapshotId);
    if (current.revision !== request.expectedRevision) {
      throw new ConcurrencyError(
        `External trust root snapshot '${request.snapshotId}' revision is ${current.revision}, expected ${request.expectedRevision}.`,
      );
    }
    if (current.status === "revoked") {
      throw new MetadataError(`External trust root snapshot '${request.snapshotId}' is revoked and terminal.`);
    }
    if (type === "retired" && current.status !== "active") {
      throw new MetadataError(`External trust root snapshot '${request.snapshotId}' must be active before retirement.`);
    }

    await this.governance.create({
      format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-external-root-snapshot-governance-event",
      formatVersion: 1,
      eventId: request.eventId,
      snapshotId: request.snapshotId,
      revision: current.revision + 1,
      type,
      ...(request.reason === undefined ? {} : { reason: request.reason }),
      occurredAt: this.clock().toISOString(),
    });
    return this.requireState(request.snapshotId);
  }

  private async requireState(snapshotId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceState> {
    const state = await this.getState(snapshotId);
    if (!state) throw new MetadataError(`External trust root snapshot '${snapshotId}' has not been activated.`);
    return state;
  }

  private async requireValidSnapshot(snapshotId: string) {
    const snapshot = await this.snapshots.get(snapshotId);
    if (!snapshot) throw new MetadataError(`Unknown external trust root snapshot '${snapshotId}'.`);
    validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotRecord(snapshot);
    if (await digestExternalTrustRoots(snapshot.roots) !== snapshot.rootDigest) {
      throw new MetadataError(`External trust root snapshot '${snapshotId}' is invalid.`);
    }
    return snapshot;
  }
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRootBindingWriter {
  verifyAndBind(
    bindingId: string,
    anchorId: string,
    snapshotId: string,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRootBindingRecord>;
}

export class RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleGovernedBundleAnchorRootCatalog {
  constructor(
    private readonly governance: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceCatalog,
    private readonly bindings: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRootBindingWriter,
  ) {}

  async verifyAndBind(
    bindingId: string,
    anchorId: string,
    snapshotId: string,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRootBindingRecord> {
    for (const [label, value] of Object.entries({ bindingId, anchorId, snapshotId })) assertText(value, label);
    await this.governance.assertActive(snapshotId);
    return this.bindings.verifyAndBind(bindingId, anchorId, snapshotId);
  }
}

export function replayRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernance(
  snapshotId: string,
  events: readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceEventRecord[],
): RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceState {
  assertText(snapshotId, "snapshotId");
  if (events.length === 0) throw new MetadataError(`External trust root snapshot '${snapshotId}' has no governance events.`);

  const ordered = [...events].sort((a, b) => a.revision - b.revision || a.eventId.localeCompare(b.eventId));
  let state: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceState | null = null;
  let previousOccurredAt: number | undefined;
  for (const [index, event] of ordered.entries()) {
    validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceEventRecord(event);
    const occurredAt = Date.parse(event.occurredAt);
    if (previousOccurredAt !== undefined && occurredAt < previousOccurredAt) {
      throw new MetadataError(`External trust root snapshot '${snapshotId}' governance timestamps are not monotonic.`);
    }
    previousOccurredAt = occurredAt;
    if (event.snapshotId !== snapshotId) throw new MetadataError(`Governance event '${event.eventId}' belongs to another snapshot.`);
    const expectedRevision = index + 1;
    if (event.revision !== expectedRevision) {
      throw new MetadataError(`External trust root snapshot '${snapshotId}' governance revision sequence is invalid.`);
    }

    if (event.type === "activated") {
      if (state) throw new MetadataError(`External trust root snapshot '${snapshotId}' cannot be activated more than once.`);
      state = {
        snapshotId,
        status: "active",
        revision: event.revision,
        activatedAt: event.occurredAt,
      };
      continue;
    }

    if (!state) throw new MetadataError(`External trust root snapshot '${snapshotId}' must be activated first.`);
    if (state.status === "revoked") throw new MetadataError(`External trust root snapshot '${snapshotId}' has events after revocation.`);
    if (event.type === "retired") {
      if (state.status !== "active") throw new MetadataError(`External trust root snapshot '${snapshotId}' cannot be retired from '${state.status}'.`);
      state = {
        ...state,
        status: "retired",
        revision: event.revision,
        retiredAt: event.occurredAt,
        ...(event.reason === undefined ? {} : { reason: event.reason }),
      };
      continue;
    }

    state = {
      ...state,
      status: "revoked",
      revision: event.revision,
      revokedAt: event.occurredAt,
      ...(event.reason === undefined ? {} : { reason: event.reason }),
    };
  }

  if (!state) throw new MetadataError(`External trust root snapshot '${snapshotId}' governance replay produced no state.`);
  return state;
}

export function validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceEventRecord(
  record: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceEventRecord,
): void {
  if (
    record.format !== "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-external-root-snapshot-governance-event"
    || record.formatVersion !== 1
  ) {
    throw new MetadataError("Unsupported external trust root snapshot governance event format.");
  }
  assertText(record.eventId, "eventId");
  assertText(record.snapshotId, "snapshotId");
  assertRevision(record.revision, "revision");
  if (!(["activated", "retired", "revoked"] as const).includes(record.type)) {
    throw new MetadataError(`Unsupported external trust root snapshot governance event type '${record.type}'.`);
  }
  if (record.reason !== undefined) assertText(record.reason, "reason");
  if (!Number.isFinite(Date.parse(record.occurredAt))) {
    throw new MetadataError("External trust root snapshot governance occurredAt must be valid.");
  }
}

function assertText(value: string, label: string): void {
  if (!value.trim()) throw new MetadataError(`External trust root snapshot governance ${label} is required.`);
}

function assertRevision(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new MetadataError(`External trust root snapshot governance ${label} must be a positive safe integer.`);
  }
}
