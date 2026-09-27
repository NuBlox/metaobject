import { ConcurrencyError, MetadataError } from "../errors/errors.js";
import type {
  RuntimeControlCycleRecord,
  RuntimeControlCycleStage,
  RuntimeControlCycleStatus,
} from "./runtime-control-cycle.js";
import type { RuntimePostureSnapshot, RuntimePostureState } from "./runtime-posture.js";
import type { RuntimePostureResponseDisposition } from "./runtime-posture-response.js";

export type RuntimeTargetStatus = "active" | "retired";

export interface RuntimeTargetDesiredProfile {
  readonly profileId: string;
  readonly profileVersion: number;
}

/** Latest trusted observed runtime state. */
export interface RuntimeTargetObservation {
  readonly profileId: string;
  readonly profileVersion: number;
  readonly deploymentId: string;
  readonly baselineId: string;
  readonly assessmentId: string;
  readonly postureSnapshotId: string;
  readonly postureState: RuntimePostureState;
  readonly observedAt: string;
  /** Present when this observation came from a completed M29 control cycle. */
  readonly controlCycleId?: string;
  readonly responseId?: string;
  readonly responseDisposition?: RuntimePostureResponseDisposition;
}

/** Last attempted M29 control cycle, including failed attempts. */
export interface RuntimeTargetControlCycleState {
  readonly cycleId: string;
  readonly status: RuntimeControlCycleStatus;
  readonly completedAt: string;
  readonly failedStage?: RuntimeControlCycleStage;
  readonly error?: string;
}

export interface RuntimeTargetRecord {
  readonly format: "nublox-metaobject-runtime-target";
  readonly formatVersion: 1;
  readonly runtimeId: string;
  readonly revision: number;
  readonly status: RuntimeTargetStatus;
  readonly desiredProfile: RuntimeTargetDesiredProfile;
  readonly observation?: RuntimeTargetObservation;
  readonly lastControlCycle?: RuntimeTargetControlCycleState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly retiredAt?: string;
}

export interface RuntimeTargetFilter {
  readonly status?: RuntimeTargetStatus;
  readonly desiredProfileId?: string;
  readonly observedProfileId?: string;
  readonly postureState?: RuntimePostureState;
}

export interface RuntimeTargetStore {
  get(runtimeId: string): Promise<RuntimeTargetRecord | null>;
  list(filter?: RuntimeTargetFilter): Promise<readonly RuntimeTargetRecord[]>;
  save(record: RuntimeTargetRecord, expectedRevision?: number): Promise<RuntimeTargetRecord>;
}

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryRuntimeTargetStore implements RuntimeTargetStore {
  readonly #records = new Map<string, RuntimeTargetRecord>();

  async get(runtimeId: string): Promise<RuntimeTargetRecord | null> {
    const record = this.#records.get(runtimeId);
    return record ? clone(record) : null;
  }

  async list(filter: RuntimeTargetFilter = {}): Promise<readonly RuntimeTargetRecord[]> {
    return [...this.#records.values()]
      .filter((record) => filter.status === undefined || record.status === filter.status)
      .filter((record) => filter.desiredProfileId === undefined || record.desiredProfile.profileId === filter.desiredProfileId)
      .filter((record) => filter.observedProfileId === undefined || record.observation?.profileId === filter.observedProfileId)
      .filter((record) => filter.postureState === undefined || record.observation?.postureState === filter.postureState)
      .sort((left, right) => left.runtimeId.localeCompare(right.runtimeId))
      .map(clone);
  }

  async save(record: RuntimeTargetRecord, expectedRevision?: number): Promise<RuntimeTargetRecord> {
    validateRuntimeTargetRecord(record);
    const current = this.#records.get(record.runtimeId);

    if (current) {
      if (expectedRevision === undefined) {
        throw new ConcurrencyError(`Runtime target '${record.runtimeId}' already exists; expectedRevision is required.`);
      }
      if (current.revision !== expectedRevision) {
        throw new ConcurrencyError(
          `Runtime target concurrency conflict for '${record.runtimeId}': expected revision ${expectedRevision}, found ${current.revision}.`,
        );
      }
      if (record.createdAt !== current.createdAt) {
        throw new MetadataError(`Runtime target '${record.runtimeId}' createdAt is immutable.`);
      }
    } else if (expectedRevision !== undefined && expectedRevision !== 0) {
      throw new ConcurrencyError(
        `Runtime target '${record.runtimeId}' does not exist; expected revision ${expectedRevision} cannot be satisfied.`,
      );
    }

    const stored = clone({
      ...record,
      revision: (current?.revision ?? 0) + 1,
      createdAt: current?.createdAt ?? record.createdAt,
    });
    this.#records.set(stored.runtimeId, stored);
    return clone(stored);
  }
}

export interface RuntimeTargetPostureSource {
  get(snapshotId: string): Promise<RuntimePostureSnapshot | null>;
}

export interface RuntimeTargetControlCycleSource {
  get(cycleId: string): Promise<RuntimeControlCycleRecord | null>;
}

export interface RuntimeTargetRegistration {
  readonly runtimeId: string;
  readonly profileId: string;
  readonly profileVersion: number;
}

export interface RuntimeFleetSummary {
  readonly total: number;
  readonly active: number;
  readonly retired: number;
  readonly posture: Readonly<Record<RuntimePostureState | "unobserved", number>>;
}

export type RuntimeTargetClock = () => Date;

/**
 * Persistent registry for independent runtime targets. The registry is a governed
 * projection over M26 posture and M29 control-cycle evidence; it does not replace
 * those immutable source records and never performs deployment/remediation work.
 */
export class RuntimeTargetCatalog {
  constructor(
    private readonly targets: RuntimeTargetStore,
    private readonly postures: RuntimeTargetPostureSource,
    private readonly cycles: RuntimeTargetControlCycleSource,
    private readonly clock: RuntimeTargetClock = () => new Date(),
  ) {}

  async register(request: RuntimeTargetRegistration): Promise<RuntimeTargetRecord> {
    assertIdentity(request.runtimeId, "runtimeId");
    assertIdentity(request.profileId, "profileId");
    assertPositiveVersion(request.profileVersion, "profileVersion");
    if (await this.targets.get(request.runtimeId)) {
      throw new ConcurrencyError(`Runtime target '${request.runtimeId}' already exists.`);
    }
    const now = this.clock().toISOString();
    return this.targets.save({
      format: "nublox-metaobject-runtime-target",
      formatVersion: 1,
      runtimeId: request.runtimeId,
      revision: 0,
      status: "active",
      desiredProfile: { profileId: request.profileId, profileVersion: request.profileVersion },
      createdAt: now,
      updatedAt: now,
    }, 0);
  }

  async setDesiredProfile(
    runtimeId: string,
    profileId: string,
    profileVersion: number,
    expectedRevision: number,
  ): Promise<RuntimeTargetRecord> {
    const current = await this.requireActive(runtimeId);
    assertExpectedRevision(expectedRevision);
    assertIdentity(profileId, "profileId");
    assertPositiveVersion(profileVersion, "profileVersion");
    return this.targets.save({
      ...current,
      desiredProfile: { profileId, profileVersion },
      updatedAt: this.clock().toISOString(),
    }, expectedRevision);
  }

  async observePosture(
    runtimeId: string,
    snapshotId: string,
    expectedRevision: number,
  ): Promise<RuntimeTargetRecord> {
    const current = await this.requireActive(runtimeId);
    assertExpectedRevision(expectedRevision);
    assertIdentity(snapshotId, "snapshotId");
    const snapshot = await this.postures.get(snapshotId);
    if (!snapshot) throw new MetadataError(`Unknown runtime posture snapshot '${snapshotId}'.`);
    if (snapshot.runtimeId !== runtimeId) {
      throw new MetadataError(`Runtime posture snapshot '${snapshotId}' belongs to runtime '${snapshot.runtimeId}', not '${runtimeId}'.`);
    }
    return this.targets.save({
      ...current,
      observation: observationFromSnapshot(snapshot),
      updatedAt: this.clock().toISOString(),
    }, expectedRevision);
  }

  async observeControlCycle(
    runtimeId: string,
    cycleId: string,
    expectedRevision: number,
  ): Promise<RuntimeTargetRecord> {
    const current = await this.requireActive(runtimeId);
    assertExpectedRevision(expectedRevision);
    assertIdentity(cycleId, "cycleId");
    const cycle = await this.cycles.get(cycleId);
    if (!cycle) throw new MetadataError(`Unknown runtime control cycle '${cycleId}'.`);
    if (cycle.runtimeId !== runtimeId) {
      throw new MetadataError(`Runtime control cycle '${cycleId}' belongs to runtime '${cycle.runtimeId}', not '${runtimeId}'.`);
    }

    const lastControlCycle: RuntimeTargetControlCycleState = {
      cycleId: cycle.cycleId,
      status: cycle.status,
      completedAt: cycle.completedAt,
      ...(cycle.failedStage === undefined ? {} : { failedStage: cycle.failedStage }),
      ...(cycle.error === undefined ? {} : { error: cycle.error }),
    };

    let observation = current.observation;
    if (cycle.status === "completed") {
      const snapshot = await this.postures.get(cycle.snapshotId);
      if (!snapshot) throw new MetadataError(`Unknown runtime posture snapshot '${cycle.snapshotId}' for completed control cycle '${cycleId}'.`);
      if (
        snapshot.runtimeId !== runtimeId
        || snapshot.baselineId !== cycle.baselineId
        || snapshot.assessmentId !== cycle.assessmentId
        || snapshot.snapshotId !== cycle.snapshotId
        || snapshot.state !== cycle.postureState
      ) {
        throw new MetadataError(`Runtime control cycle '${cycleId}' does not match its posture evidence.`);
      }
      observation = {
        ...observationFromSnapshot(snapshot),
        controlCycleId: cycle.cycleId,
        responseId: cycle.responseId,
        responseDisposition: cycle.responseDisposition!,
      };
    }

    return this.targets.save({
      ...current,
      ...(observation === undefined ? {} : { observation }),
      lastControlCycle,
      updatedAt: this.clock().toISOString(),
    }, expectedRevision);
  }

  async retire(runtimeId: string, expectedRevision: number): Promise<RuntimeTargetRecord> {
    const current = await this.requireActive(runtimeId);
    assertExpectedRevision(expectedRevision);
    const now = this.clock().toISOString();
    return this.targets.save({
      ...current,
      status: "retired",
      retiredAt: now,
      updatedAt: now,
    }, expectedRevision);
  }

  async get(runtimeId: string): Promise<RuntimeTargetRecord | null> {
    assertIdentity(runtimeId, "runtimeId");
    return this.targets.get(runtimeId);
  }

  async list(filter: RuntimeTargetFilter = {}): Promise<readonly RuntimeTargetRecord[]> {
    return this.targets.list(filter);
  }

  async summary(): Promise<RuntimeFleetSummary> {
    const records = await this.targets.list();
    const posture: Record<RuntimePostureState | "unobserved", number> = {
      verified: 0,
      warning: 0,
      drifted: 0,
      remediating: 0,
      review: 0,
      restored: 0,
      stale: 0,
      unobserved: 0,
    };
    for (const record of records) {
      posture[record.observation?.postureState ?? "unobserved"] += 1;
    }
    return {
      total: records.length,
      active: records.filter((record) => record.status === "active").length,
      retired: records.filter((record) => record.status === "retired").length,
      posture,
    };
  }

  private async requireActive(runtimeId: string): Promise<RuntimeTargetRecord> {
    assertIdentity(runtimeId, "runtimeId");
    const current = await this.targets.get(runtimeId);
    if (!current) throw new MetadataError(`Unknown runtime target '${runtimeId}'.`);
    if (current.status !== "active") throw new MetadataError(`Runtime target '${runtimeId}' is retired.`);
    return current;
  }
}

function observationFromSnapshot(snapshot: RuntimePostureSnapshot): RuntimeTargetObservation {
  return {
    profileId: snapshot.profileId,
    profileVersion: snapshot.profileVersion,
    deploymentId: snapshot.deploymentId,
    baselineId: snapshot.baselineId,
    assessmentId: snapshot.assessmentId,
    postureSnapshotId: snapshot.snapshotId,
    postureState: snapshot.state,
    observedAt: snapshot.capturedAt,
  };
}

function assertIdentity(value: string, label: string): void {
  if (!value.trim()) throw new MetadataError(`Runtime target ${label} is required.`);
}

function assertPositiveVersion(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new MetadataError(`Runtime target ${label} must be a positive integer.`);
}

function assertExpectedRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new MetadataError("Runtime target expectedRevision must be a positive integer.");
}

const validPostureStates = new Set<RuntimePostureState>([
  "verified",
  "warning",
  "drifted",
  "remediating",
  "review",
  "restored",
  "stale",
]);

export function validateRuntimeTargetRecord(record: RuntimeTargetRecord): void {
  if (record.format !== "nublox-metaobject-runtime-target" || record.formatVersion !== 1) {
    throw new MetadataError("Unsupported runtime target format.");
  }
  assertIdentity(record.runtimeId, "runtimeId");
  if (!Number.isSafeInteger(record.revision) || record.revision < 0) {
    throw new MetadataError("Runtime target revision must be a non-negative integer.");
  }
  if (record.status !== "active" && record.status !== "retired") {
    throw new MetadataError(`Invalid runtime target status '${String(record.status)}'.`);
  }
  assertIdentity(record.desiredProfile.profileId, "desired profileId");
  assertPositiveVersion(record.desiredProfile.profileVersion, "desired profileVersion");
  if (!record.createdAt.trim() || !record.updatedAt.trim()) throw new MetadataError("Runtime target timestamps are required.");
  if (record.status === "active" && record.retiredAt !== undefined) {
    throw new MetadataError("Active runtime target cannot contain retiredAt.");
  }
  if (record.status === "retired" && !record.retiredAt?.trim()) {
    throw new MetadataError("Retired runtime target requires retiredAt.");
  }

  if (record.observation !== undefined) {
    const observation = record.observation;
    for (const [label, value] of Object.entries({
      profileId: observation.profileId,
      deploymentId: observation.deploymentId,
      baselineId: observation.baselineId,
      assessmentId: observation.assessmentId,
      postureSnapshotId: observation.postureSnapshotId,
      observedAt: observation.observedAt,
    })) {
      if (!value.trim()) throw new MetadataError(`Runtime target observation ${label} is required.`);
    }
    assertPositiveVersion(observation.profileVersion, "observed profileVersion");
    if (!validPostureStates.has(observation.postureState)) {
      throw new MetadataError(`Invalid runtime target posture state '${String(observation.postureState)}'.`);
    }
    if (observation.controlCycleId !== undefined && !observation.controlCycleId.trim()) {
      throw new MetadataError("Runtime target observation controlCycleId cannot be empty.");
    }
    if (observation.responseId !== undefined && !observation.responseId.trim()) {
      throw new MetadataError("Runtime target observation responseId cannot be empty.");
    }
    if (
      observation.responseDisposition !== undefined
      && observation.responseDisposition !== "no-action"
      && observation.responseDisposition !== "notify"
      && observation.responseDisposition !== "remediate"
      && observation.responseDisposition !== "review"
    ) {
      throw new MetadataError(`Invalid runtime target response disposition '${String(observation.responseDisposition)}'.`);
    }
  }

  if (record.lastControlCycle !== undefined) {
    const cycle = record.lastControlCycle;
    if (!cycle.cycleId.trim() || !cycle.completedAt.trim()) {
      throw new MetadataError("Runtime target last control-cycle identity/timestamp are required.");
    }
    if (cycle.status === "completed") {
      if (cycle.failedStage !== undefined || cycle.error !== undefined) {
        throw new MetadataError("Completed runtime target control cycle cannot contain failure state.");
      }
    } else {
      if (cycle.failedStage === undefined || !cycle.error?.trim()) {
        throw new MetadataError("Failed runtime target control cycle requires failedStage and error.");
      }
    }
  }
}
