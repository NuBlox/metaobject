import { ConcurrencyError, MetadataError } from "../errors/errors.js";
import type { RuntimeFleetFairDispatchRecord } from "./runtime-fleet-convergence-fair-dispatch.js";
import { validateRuntimeFleetFairDispatchRecord } from "./runtime-fleet-convergence-fair-dispatch.js";
import type { RuntimeFleetFairReservationRecord } from "./runtime-fleet-convergence-fair-reservation.js";
import { validateRuntimeFleetFairReservationRecord } from "./runtime-fleet-convergence-fair-reservation.js";
import type { RuntimeFleetHandoffRecoveryAdmissionSource } from "./runtime-fleet-convergence-handoff-recovery.js";
import type {
  RuntimeFleetHandoffRecoveryResolutionExecutionResult,
  RuntimeFleetHandoffRecoveryResolutionRecord,
} from "./runtime-fleet-convergence-handoff-resolution.js";
import { validateRuntimeFleetHandoffRecoveryResolutionRecord } from "./runtime-fleet-convergence-handoff-resolution.js";

export type RuntimeFleetHandoffResolutionExecutionStatus = "running" | "completed" | "failed" | "uncertain";

export interface RuntimeFleetHandoffResolutionExecutionWorkIdentity {
  readonly workId: string;
  readonly runtimeId: string;
  readonly action: RuntimeFleetFairReservationRecord["work"][number]["action"];
  readonly workRevision: number;
  readonly fairnessRank: number;
}

/**
 * Full immutable M42 identity captured when an M46 execution starts. Optional
 * only so persisted v0.46 receipts remain readable after the v0.47 hardening.
 */
export interface RuntimeFleetHandoffResolutionExecutionIdentity {
  readonly dispatchId: string;
  readonly workerId: string;
  readonly handoffAt: string;
  readonly work: readonly RuntimeFleetHandoffResolutionExecutionWorkIdentity[];
}

export interface RuntimeFleetHandoffResolutionExecutionRecord {
  readonly format: "nublox-metaobject-runtime-fleet-handoff-resolution-execution";
  readonly formatVersion: 1;
  readonly executionId: string;
  readonly revision: number;
  readonly status: RuntimeFleetHandoffResolutionExecutionStatus;
  readonly resolutionId: string;
  readonly recoveryId: string;
  readonly reservationId: string;
  readonly action: RuntimeFleetHandoffRecoveryResolutionRecord["action"];
  readonly actorId: string;
  readonly startReservationRevision: number;
  readonly admissionId: string;
  readonly handoffIdentity?: RuntimeFleetHandoffResolutionExecutionIdentity;
  readonly startAdmissionStatus?: RuntimeFleetFairDispatchRecord["status"];
  readonly startAdmissionRevision?: number;
  readonly startedAt: string;
  readonly outcome?: RuntimeFleetHandoffRecoveryResolutionExecutionResult["outcome"];
  readonly finalReservationStatus?: RuntimeFleetFairReservationRecord["status"];
  readonly finalReservationRevision?: number;
  readonly finalAdmissionStatus?: RuntimeFleetFairDispatchRecord["status"];
  readonly finalAdmissionRevision?: number;
  readonly error?: string;
  readonly finishedAt?: string;
}

export interface RuntimeFleetHandoffResolutionExecutionFilter {
  readonly status?: RuntimeFleetHandoffResolutionExecutionStatus;
  readonly action?: RuntimeFleetHandoffRecoveryResolutionRecord["action"];
  readonly resolutionId?: string;
}

export interface RuntimeFleetHandoffResolutionExecutionStore {
  get(executionId: string): Promise<RuntimeFleetHandoffResolutionExecutionRecord | null>;
  list(filter?: RuntimeFleetHandoffResolutionExecutionFilter): Promise<readonly RuntimeFleetHandoffResolutionExecutionRecord[]>;
  create(record: RuntimeFleetHandoffResolutionExecutionRecord): Promise<RuntimeFleetHandoffResolutionExecutionRecord>;
  save(
    record: RuntimeFleetHandoffResolutionExecutionRecord,
    expectedRevision: number,
  ): Promise<RuntimeFleetHandoffResolutionExecutionRecord>;
}

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryRuntimeFleetHandoffResolutionExecutionStore implements RuntimeFleetHandoffResolutionExecutionStore {
  readonly #records = new Map<string, RuntimeFleetHandoffResolutionExecutionRecord>();

  async get(executionId: string): Promise<RuntimeFleetHandoffResolutionExecutionRecord | null> {
    const record = this.#records.get(executionId);
    return record ? clone(record) : null;
  }

  async list(
    filter: RuntimeFleetHandoffResolutionExecutionFilter = {},
  ): Promise<readonly RuntimeFleetHandoffResolutionExecutionRecord[]> {
    return [...this.#records.values()]
      .filter((record) => filter.status === undefined || record.status === filter.status)
      .filter((record) => filter.action === undefined || record.action === filter.action)
      .filter((record) => filter.resolutionId === undefined || record.resolutionId === filter.resolutionId)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.executionId.localeCompare(right.executionId))
      .map(clone);
  }

  async create(record: RuntimeFleetHandoffResolutionExecutionRecord): Promise<RuntimeFleetHandoffResolutionExecutionRecord> {
    validateRuntimeFleetHandoffResolutionExecutionRecord(record);
    if (record.status !== "running" || record.revision !== 0) {
      throw new MetadataError("New handoff resolution execution receipts must be running at revision zero.");
    }
    if (this.#records.has(record.executionId)) {
      throw new ConcurrencyError(`Runtime fleet handoff resolution execution '${record.executionId}' already exists.`);
    }
    const stored = clone({ ...record, revision: 1 });
    this.#records.set(stored.executionId, stored);
    return clone(stored);
  }

  async save(
    record: RuntimeFleetHandoffResolutionExecutionRecord,
    expectedRevision: number,
  ): Promise<RuntimeFleetHandoffResolutionExecutionRecord> {
    validateRuntimeFleetHandoffResolutionExecutionRecord(record);
    const current = this.#records.get(record.executionId);
    if (!current) throw new MetadataError(`Unknown runtime fleet handoff resolution execution '${record.executionId}'.`);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new MetadataError("Runtime fleet handoff resolution execution expectedRevision must be a positive integer.");
    }
    if (current.revision !== expectedRevision) {
      throw new ConcurrencyError(
        `Runtime fleet handoff resolution execution conflict for '${record.executionId}': expected revision ${expectedRevision}, found ${current.revision}.`,
      );
    }
    if (current.status !== "running") {
      throw new MetadataError(`Terminal runtime fleet handoff resolution execution '${record.executionId}' is immutable.`);
    }
    for (const [label, before, after] of [
      ["resolutionId", current.resolutionId, record.resolutionId],
      ["recoveryId", current.recoveryId, record.recoveryId],
      ["reservationId", current.reservationId, record.reservationId],
      ["action", current.action, record.action],
      ["actorId", current.actorId, record.actorId],
      ["startReservationRevision", current.startReservationRevision, record.startReservationRevision],
      ["admissionId", current.admissionId, record.admissionId],
      ["startAdmissionStatus", current.startAdmissionStatus, record.startAdmissionStatus],
      ["startAdmissionRevision", current.startAdmissionRevision, record.startAdmissionRevision],
      ["startedAt", current.startedAt, record.startedAt],
    ] as const) {
      if (before !== after) {
        throw new MetadataError(`Runtime fleet handoff resolution execution '${record.executionId}' ${label} is immutable.`);
      }
    }
    if (JSON.stringify(current.handoffIdentity) !== JSON.stringify(record.handoffIdentity)) {
      throw new MetadataError(`Runtime fleet handoff resolution execution '${record.executionId}' handoffIdentity is immutable.`);
    }
    const stored = clone({ ...record, revision: current.revision + 1 });
    this.#records.set(stored.executionId, stored);
    return clone(stored);
  }
}

export interface RuntimeFleetHandoffResolutionSource {
  get(resolutionId: string): Promise<RuntimeFleetHandoffRecoveryResolutionRecord | null>;
  execute(resolutionId: string): Promise<RuntimeFleetHandoffRecoveryResolutionExecutionResult>;
}

export interface RuntimeFleetHandoffResolutionReservationSource {
  get(reservationId: string): Promise<RuntimeFleetFairReservationRecord | null>;
}

export interface RuntimeFleetHandoffResolutionExecutionRequest {
  readonly executionId: string;
  readonly resolutionId: string;
}

export type RuntimeFleetHandoffResolutionExecutionClock = () => Date;

/**
 * Persist a receipt before invoking M45 and retain enough fencing evidence to
 * recover after a crash without guessing whether a side effect happened.
 */
export class RuntimeFleetHandoffResolutionExecutionCatalog {
  constructor(
    private readonly resolutions: RuntimeFleetHandoffResolutionSource,
    private readonly reservations: RuntimeFleetHandoffResolutionReservationSource,
    private readonly admissions: RuntimeFleetHandoffRecoveryAdmissionSource,
    private readonly executions: RuntimeFleetHandoffResolutionExecutionStore,
    private readonly clock: RuntimeFleetHandoffResolutionExecutionClock = () => new Date(),
  ) {}

  async run(request: RuntimeFleetHandoffResolutionExecutionRequest): Promise<RuntimeFleetHandoffResolutionExecutionRecord> {
    assertText(request.executionId, "executionId");
    assertText(request.resolutionId, "resolutionId");
    if (await this.executions.get(request.executionId)) {
      throw new ConcurrencyError(`Runtime fleet handoff resolution execution '${request.executionId}' already exists.`);
    }

    const resolution = await this.requireResolution(request.resolutionId);
    const reservation = await this.requireReservation(resolution.reservationId);
    assertResolutionReservationSnapshot(resolution, reservation, "before M46 execution");
    const admission = await this.admissions.get(resolution.admissionId);
    if (admission) validateRuntimeFleetFairDispatchRecord(admission);
    assertResolutionAdmissionSnapshot(resolution, admission, "before M46 execution");

    const running = await this.executions.create({
      format: "nublox-metaobject-runtime-fleet-handoff-resolution-execution",
      formatVersion: 1,
      executionId: request.executionId,
      revision: 0,
      status: "running",
      resolutionId: resolution.resolutionId,
      recoveryId: resolution.recoveryId,
      reservationId: resolution.reservationId,
      action: resolution.action,
      actorId: resolution.actorId,
      startReservationRevision: reservation.revision,
      admissionId: resolution.admissionId,
      handoffIdentity: captureHandoffIdentity(reservation),
      ...(admission === null ? {} : {
        startAdmissionStatus: admission.status,
        startAdmissionRevision: admission.revision,
      }),
      startedAt: this.clock().toISOString(),
    });
    return this.executeRunning(running, resolution);
  }

  async resume(executionId: string): Promise<RuntimeFleetHandoffResolutionExecutionRecord> {
    assertText(executionId, "executionId");
    const execution = await this.executions.get(executionId);
    if (!execution) throw new MetadataError(`Unknown runtime fleet handoff resolution execution '${executionId}'.`);
    validateRuntimeFleetHandoffResolutionExecutionRecord(execution);
    if (execution.status !== "running") return execution;

    const resolution = await this.requireResolution(execution.resolutionId);
    assertExecutionMatchesResolution(execution, resolution);
    const reservation = await this.requireReservation(execution.reservationId);
    const admission = await this.admissions.get(execution.admissionId);
    if (admission) validateRuntimeFleetFairDispatchRecord(admission);

    if (isExpectedTerminalReservation(execution.action, reservation)) {
      return this.completeFromObservedState(execution, reservation, admission);
    }
    if (matchesStartingSnapshot(execution, resolution, reservation, admission)) {
      return this.executeRunning(execution, resolution);
    }
    return this.finishUncertain(
      execution,
      reservation,
      admission,
      "Fencing state changed while the M45 outcome was not durably recorded; a fresh M44/M45 decision is required.",
    );
  }

  async get(executionId: string): Promise<RuntimeFleetHandoffResolutionExecutionRecord | null> {
    assertText(executionId, "executionId");
    return this.executions.get(executionId);
  }

  async history(
    filter: RuntimeFleetHandoffResolutionExecutionFilter = {},
  ): Promise<readonly RuntimeFleetHandoffResolutionExecutionRecord[]> {
    return this.executions.list(filter);
  }

  private async executeRunning(
    execution: RuntimeFleetHandoffResolutionExecutionRecord,
    resolution: RuntimeFleetHandoffRecoveryResolutionRecord,
  ): Promise<RuntimeFleetHandoffResolutionExecutionRecord> {
    try {
      const result = await this.resolutions.execute(resolution.resolutionId);
      assertTerminalReservationIdentity(execution, result.reservation);
      const admission = await this.admissions.get(execution.admissionId);
      if (admission) validateRuntimeFleetFairDispatchRecord(admission);
      return this.executions.save({
        ...execution,
        status: "completed",
        outcome: result.outcome,
        finalReservationStatus: result.reservation.status,
        finalReservationRevision: result.reservation.revision,
        ...(admission === null ? {} : {
          finalAdmissionStatus: admission.status,
          finalAdmissionRevision: admission.revision,
        }),
        finishedAt: this.clock().toISOString(),
      }, execution.revision);
    } catch (error) {
      const reservation = await this.requireReservation(execution.reservationId);
      const admission = await this.admissions.get(execution.admissionId);
      if (admission) validateRuntimeFleetFairDispatchRecord(admission);
      const message = errorMessage(error);

      if (isExpectedTerminalReservation(execution.action, reservation)) {
        try {
          return await this.completeFromObservedState(execution, reservation, admission);
        } catch (identityError) {
          return this.finishUncertain(execution, reservation, admission, errorMessage(identityError));
        }
      }
      if (matchesStartingSnapshot(execution, resolution, reservation, admission)) {
        return this.executions.save({
          ...execution,
          status: "failed",
          error: message,
          finalReservationStatus: reservation.status,
          finalReservationRevision: reservation.revision,
          ...(admission === null ? {} : {
            finalAdmissionStatus: admission.status,
            finalAdmissionRevision: admission.revision,
          }),
          finishedAt: this.clock().toISOString(),
        }, execution.revision);
      }
      return this.finishUncertain(execution, reservation, admission, message);
    }
  }

  private async completeFromObservedState(
    execution: RuntimeFleetHandoffResolutionExecutionRecord,
    reservation: RuntimeFleetFairReservationRecord,
    admission: RuntimeFleetFairDispatchRecord | null,
  ): Promise<RuntimeFleetHandoffResolutionExecutionRecord> {
    assertTerminalReservationIdentity(execution, reservation);
    const outcome = execution.action === "resume" ? "resumed" : "cancelled";
    return this.executions.save({
      ...execution,
      status: "completed",
      outcome,
      finalReservationStatus: reservation.status,
      finalReservationRevision: reservation.revision,
      ...(admission === null ? {} : {
        finalAdmissionStatus: admission.status,
        finalAdmissionRevision: admission.revision,
      }),
      finishedAt: this.clock().toISOString(),
    }, execution.revision);
  }

  private async finishUncertain(
    execution: RuntimeFleetHandoffResolutionExecutionRecord,
    reservation: RuntimeFleetFairReservationRecord,
    admission: RuntimeFleetFairDispatchRecord | null,
    error: string,
  ): Promise<RuntimeFleetHandoffResolutionExecutionRecord> {
    return this.executions.save({
      ...execution,
      status: "uncertain",
      error,
      finalReservationStatus: reservation.status,
      finalReservationRevision: reservation.revision,
      ...(admission === null ? {} : {
        finalAdmissionStatus: admission.status,
        finalAdmissionRevision: admission.revision,
      }),
      finishedAt: this.clock().toISOString(),
    }, execution.revision);
  }

  private async requireResolution(resolutionId: string): Promise<RuntimeFleetHandoffRecoveryResolutionRecord> {
    const resolution = await this.resolutions.get(resolutionId);
    if (!resolution) throw new MetadataError(`Unknown runtime fleet handoff recovery resolution '${resolutionId}'.`);
    validateRuntimeFleetHandoffRecoveryResolutionRecord(resolution);
    return resolution;
  }

  private async requireReservation(reservationId: string): Promise<RuntimeFleetFairReservationRecord> {
    const reservation = await this.reservations.get(reservationId);
    if (!reservation) throw new ConcurrencyError(`Runtime fleet fair reservation '${reservationId}' no longer exists.`);
    validateRuntimeFleetFairReservationRecord(reservation);
    return reservation;
  }
}

function captureHandoffIdentity(
  reservation: RuntimeFleetFairReservationRecord,
): RuntimeFleetHandoffResolutionExecutionIdentity {
  if (!reservation.handoffAt) {
    throw new MetadataError(`Runtime fleet fair reservation '${reservation.reservationId}' has no handoffAt identity.`);
  }
  return {
    dispatchId: reservation.dispatchId,
    workerId: reservation.workerId,
    handoffAt: reservation.handoffAt,
    work: reservation.work.map((item) => ({
      workId: item.workId,
      runtimeId: item.runtimeId,
      action: item.action,
      workRevision: item.workRevision,
      fairnessRank: item.fairnessRank,
    })),
  };
}

function assertExecutionMatchesResolution(
  execution: RuntimeFleetHandoffResolutionExecutionRecord,
  resolution: RuntimeFleetHandoffRecoveryResolutionRecord,
): void {
  if (
    execution.resolutionId !== resolution.resolutionId
    || execution.recoveryId !== resolution.recoveryId
    || execution.reservationId !== resolution.reservationId
    || execution.action !== resolution.action
    || execution.actorId !== resolution.actorId
    || execution.admissionId !== resolution.admissionId
  ) {
    throw new MetadataError(`M46 execution '${execution.executionId}' does not match its immutable M45 resolution.`);
  }
  if (execution.handoffIdentity !== undefined && (
    execution.handoffIdentity.dispatchId !== resolution.dispatchId
    || execution.handoffIdentity.workerId !== resolution.workerId
    || execution.handoffIdentity.handoffAt !== resolution.handoffAt
  )) {
    throw new MetadataError(`M46 execution '${execution.executionId}' handoff identity does not match its M45 resolution.`);
  }
}

function assertResolutionReservationSnapshot(
  resolution: RuntimeFleetHandoffRecoveryResolutionRecord,
  reservation: RuntimeFleetFairReservationRecord,
  stage: string,
): void {
  if (
    reservation.status !== "handoff"
    || reservation.revision !== resolution.reservationRevision
    || reservation.admissionId !== resolution.admissionId
    || reservation.dispatchId !== resolution.dispatchId
    || reservation.workerId !== resolution.workerId
    || reservation.handoffAt !== resolution.handoffAt
  ) {
    throw new ConcurrencyError(`Runtime fleet fair reservation '${reservation.reservationId}' changed ${stage}.`);
  }
}

function assertExecutionHandoffIdentity(
  execution: RuntimeFleetHandoffResolutionExecutionRecord,
  reservation: RuntimeFleetFairReservationRecord,
): void {
  const identity = execution.handoffIdentity;
  if (identity === undefined) return;
  const current = captureHandoffIdentity(reservation);
  if (JSON.stringify(identity) !== JSON.stringify(current)) {
    throw new ConcurrencyError(
      `Runtime fleet fair reservation '${reservation.reservationId}' immutable handoff identity changed after M46 execution started.`,
    );
  }
}

function assertResolutionAdmissionSnapshot(
  resolution: RuntimeFleetHandoffRecoveryResolutionRecord,
  admission: RuntimeFleetFairDispatchRecord | null,
  stage: string,
): void {
  if (resolution.admissionStatus === undefined) {
    if (admission !== null) throw new ConcurrencyError(`M40 admission '${resolution.admissionId}' appeared ${stage}.`);
    return;
  }
  if (
    admission === null
    || admission.status !== resolution.admissionStatus
    || admission.revision !== resolution.admissionRevision
  ) {
    throw new ConcurrencyError(`M40 admission '${resolution.admissionId}' changed ${stage}.`);
  }
}

function matchesStartingSnapshot(
  execution: RuntimeFleetHandoffResolutionExecutionRecord,
  resolution: RuntimeFleetHandoffRecoveryResolutionRecord,
  reservation: RuntimeFleetFairReservationRecord,
  admission: RuntimeFleetFairDispatchRecord | null,
): boolean {
  try {
    assertResolutionReservationSnapshot(resolution, reservation, "after M46 started");
    assertExecutionHandoffIdentity(execution, reservation);
    if (reservation.revision !== execution.startReservationRevision) return false;
    if (execution.startAdmissionStatus === undefined) return admission === null;
    return admission !== null
      && admission.status === execution.startAdmissionStatus
      && admission.revision === execution.startAdmissionRevision;
  } catch {
    return false;
  }
}

function isExpectedTerminalReservation(
  action: RuntimeFleetHandoffRecoveryResolutionRecord["action"],
  reservation: RuntimeFleetFairReservationRecord,
): boolean {
  return action === "resume" ? reservation.status === "consumed" : reservation.status === "released";
}

function assertTerminalReservationIdentity(
  execution: RuntimeFleetHandoffResolutionExecutionRecord,
  reservation: RuntimeFleetFairReservationRecord,
): void {
  if (
    reservation.reservationId !== execution.reservationId
    || reservation.admissionId !== execution.admissionId
  ) {
    throw new MetadataError(`Observed terminal reservation does not belong to M46 execution '${execution.executionId}'.`);
  }
  assertExecutionHandoffIdentity(execution, reservation);
  if (reservation.revision <= execution.startReservationRevision) {
    throw new ConcurrencyError(`Terminal reservation '${reservation.reservationId}' did not advance beyond the M46 start revision.`);
  }
}

export function validateRuntimeFleetHandoffResolutionExecutionRecord(
  record: RuntimeFleetHandoffResolutionExecutionRecord,
): void {
  if (record.format !== "nublox-metaobject-runtime-fleet-handoff-resolution-execution" || record.formatVersion !== 1) {
    throw new MetadataError("Unsupported runtime fleet handoff resolution execution format.");
  }
  for (const [label, value] of Object.entries({
    executionId: record.executionId,
    resolutionId: record.resolutionId,
    recoveryId: record.recoveryId,
    reservationId: record.reservationId,
    actorId: record.actorId,
    admissionId: record.admissionId,
    startedAt: record.startedAt,
  })) assertText(value, label);
  if (!Number.isSafeInteger(record.revision) || record.revision < 0) {
    throw new MetadataError("Runtime fleet handoff resolution execution revision must be a non-negative integer.");
  }
  assertPositiveInteger(record.startReservationRevision, "startReservationRevision");
  if (record.handoffIdentity !== undefined) validateHandoffIdentity(record.handoffIdentity);
  if ((record.startAdmissionStatus === undefined) !== (record.startAdmissionRevision === undefined)) {
    throw new MetadataError("M46 startAdmissionStatus and startAdmissionRevision must be supplied together.");
  }
  if (record.startAdmissionRevision !== undefined) assertPositiveInteger(record.startAdmissionRevision, "startAdmissionRevision");
  if (!Number.isFinite(Date.parse(record.startedAt))) {
    throw new MetadataError("Runtime fleet handoff resolution execution startedAt must be a valid timestamp.");
  }
  if (record.status === "running") {
    if (
      record.outcome !== undefined
      || record.finalReservationStatus !== undefined
      || record.finalReservationRevision !== undefined
      || record.finalAdmissionStatus !== undefined
      || record.finalAdmissionRevision !== undefined
      || record.error !== undefined
      || record.finishedAt !== undefined
    ) {
      throw new MetadataError("Running M46 execution cannot contain terminal evidence.");
    }
    return;
  }
  if (!record.finishedAt?.trim() || !Number.isFinite(Date.parse(record.finishedAt))) {
    throw new MetadataError("Terminal M46 execution requires a valid finishedAt timestamp.");
  }
  if (record.finalReservationStatus === undefined || record.finalReservationRevision === undefined) {
    throw new MetadataError("Terminal M46 execution requires final reservation evidence.");
  }
  assertPositiveInteger(record.finalReservationRevision, "finalReservationRevision");
  if ((record.finalAdmissionStatus === undefined) !== (record.finalAdmissionRevision === undefined)) {
    throw new MetadataError("M46 finalAdmissionStatus and finalAdmissionRevision must be supplied together.");
  }
  if (record.finalAdmissionRevision !== undefined) assertPositiveInteger(record.finalAdmissionRevision, "finalAdmissionRevision");
  if (record.status === "completed") {
    if (record.outcome === undefined || record.error !== undefined) {
      throw new MetadataError("Completed M46 execution requires outcome and cannot contain error.");
    }
  } else if (!record.error?.trim() || record.outcome !== undefined) {
    throw new MetadataError("Failed/uncertain M46 execution requires error and cannot contain outcome.");
  }
}

function validateHandoffIdentity(identity: RuntimeFleetHandoffResolutionExecutionIdentity): void {
  assertText(identity.dispatchId, "handoffIdentity.dispatchId");
  assertText(identity.workerId, "handoffIdentity.workerId");
  if (!Number.isFinite(Date.parse(identity.handoffAt))) {
    throw new MetadataError("M46 handoffIdentity.handoffAt must be a valid timestamp.");
  }
  if (identity.work.length === 0) {
    throw new MetadataError("M46 handoffIdentity requires at least one work item.");
  }
  const ids = new Set<string>();
  let previousRank = 0;
  for (const item of identity.work) {
    assertText(item.workId, "handoffIdentity.workId");
    assertText(item.runtimeId, "handoffIdentity.runtimeId");
    assertPositiveInteger(item.workRevision, "handoffIdentity.workRevision");
    assertPositiveInteger(item.fairnessRank, "handoffIdentity.fairnessRank");
    if (item.fairnessRank <= previousRank) {
      throw new MetadataError("M46 handoffIdentity work must preserve ascending fairness rank.");
    }
    if (ids.has(item.workId)) {
      throw new MetadataError(`M46 handoffIdentity contains duplicate work '${item.workId}'.`);
    }
    previousRank = item.fairnessRank;
    ids.add(item.workId);
  }
}

function assertText(value: string, label: string): void {
  if (!value.trim()) throw new MetadataError(`Runtime fleet handoff resolution execution ${label} is required.`);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new MetadataError(`Runtime fleet handoff resolution execution ${label} must be a positive integer.`);
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "Runtime fleet handoff resolution execution failed with an unknown error.";
}
