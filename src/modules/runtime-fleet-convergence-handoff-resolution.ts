import { ConcurrencyError, MetadataError } from "../errors/errors.js";
import type { RuntimeFleetFairDispatchRecord } from "./runtime-fleet-convergence-fair-dispatch.js";
import { validateRuntimeFleetFairDispatchRecord } from "./runtime-fleet-convergence-fair-dispatch.js";
import type {
  RuntimeFleetFairReservationDispatchResult,
  RuntimeFleetFairReservationRecord,
} from "./runtime-fleet-convergence-fair-reservation.js";
import { validateRuntimeFleetFairReservationRecord } from "./runtime-fleet-convergence-fair-reservation.js";
import type {
  RuntimeFleetHandoffRecoveryAdmissionSource,
  RuntimeFleetHandoffRecoveryAudit,
  RuntimeFleetHandoffRecoveryDecision,
  RuntimeFleetHandoffRecoveryReservationController,
} from "./runtime-fleet-convergence-handoff-recovery.js";
import { validateRuntimeFleetHandoffRecoveryAudit } from "./runtime-fleet-convergence-handoff-recovery.js";

export type RuntimeFleetHandoffRecoveryResolutionAction = "resume" | "cancel";

export interface RuntimeFleetHandoffRecoveryResolutionRecord {
  readonly format: "nublox-metaobject-runtime-fleet-handoff-recovery-resolution";
  readonly formatVersion: 1;
  readonly resolutionId: string;
  readonly recoveryId: string;
  readonly reservationId: string;
  readonly reservationRevision: number;
  readonly admissionId: string;
  readonly dispatchId: string;
  readonly workerId: string;
  readonly handoffAt: string;
  readonly action: RuntimeFleetHandoffRecoveryResolutionAction;
  readonly actorId: string;
  readonly reason: string;
  readonly admissionStatus?: RuntimeFleetFairDispatchRecord["status"];
  readonly admissionRevision?: number;
  readonly resolvedAt: string;
}

export interface RuntimeFleetHandoffRecoveryResolutionFilter {
  readonly actorId?: string;
  readonly action?: RuntimeFleetHandoffRecoveryResolutionAction;
  readonly recoveryId?: string;
}

export interface RuntimeFleetHandoffRecoveryResolutionStore {
  get(resolutionId: string): Promise<RuntimeFleetHandoffRecoveryResolutionRecord | null>;
  list(filter?: RuntimeFleetHandoffRecoveryResolutionFilter): Promise<readonly RuntimeFleetHandoffRecoveryResolutionRecord[]>;
  create(record: RuntimeFleetHandoffRecoveryResolutionRecord): Promise<RuntimeFleetHandoffRecoveryResolutionRecord>;
}

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryRuntimeFleetHandoffRecoveryResolutionStore implements RuntimeFleetHandoffRecoveryResolutionStore {
  readonly #records = new Map<string, RuntimeFleetHandoffRecoveryResolutionRecord>();

  async get(resolutionId: string): Promise<RuntimeFleetHandoffRecoveryResolutionRecord | null> {
    const record = this.#records.get(resolutionId);
    return record ? clone(record) : null;
  }

  async list(
    filter: RuntimeFleetHandoffRecoveryResolutionFilter = {},
  ): Promise<readonly RuntimeFleetHandoffRecoveryResolutionRecord[]> {
    return [...this.#records.values()]
      .filter((record) => filter.actorId === undefined || record.actorId === filter.actorId)
      .filter((record) => filter.action === undefined || record.action === filter.action)
      .filter((record) => filter.recoveryId === undefined || record.recoveryId === filter.recoveryId)
      .sort((left, right) => left.resolvedAt.localeCompare(right.resolvedAt) || left.resolutionId.localeCompare(right.resolutionId))
      .map(clone);
  }

  async create(record: RuntimeFleetHandoffRecoveryResolutionRecord): Promise<RuntimeFleetHandoffRecoveryResolutionRecord> {
    validateRuntimeFleetHandoffRecoveryResolutionRecord(record);
    if (this.#records.has(record.resolutionId)) {
      throw new ConcurrencyError(`Runtime fleet handoff recovery resolution '${record.resolutionId}' already exists.`);
    }
    const stored = clone(record);
    this.#records.set(stored.resolutionId, stored);
    return clone(stored);
  }
}

export interface RuntimeFleetHandoffRecoveryAuditSource {
  get(recoveryId: string): Promise<RuntimeFleetHandoffRecoveryAudit | null>;
}

export interface RuntimeFleetHandoffRecoveryResolutionRequest {
  readonly resolutionId: string;
  readonly recoveryId: string;
  readonly reservationId: string;
  readonly action: RuntimeFleetHandoffRecoveryResolutionAction;
  readonly actorId: string;
  readonly reason: string;
}

export type RuntimeFleetHandoffRecoveryResolutionExecutionOutcome = "resumed" | "cancelled";

export interface RuntimeFleetHandoffRecoveryResolutionExecutionResult {
  readonly outcome: RuntimeFleetHandoffRecoveryResolutionExecutionOutcome;
  readonly resolution: RuntimeFleetHandoffRecoveryResolutionRecord;
  readonly reservation: RuntimeFleetFairReservationRecord;
  readonly fairDispatch?: RuntimeFleetFairReservationDispatchResult["fairDispatch"];
}

export type RuntimeFleetHandoffRecoveryResolutionClock = () => Date;

/**
 * Resolve an M44 manual-review decision into an explicit, attributable resume or
 * cancel choice. The resolution freezes the exact M42/M40 evidence seen at the
 * point of approval and revalidates it again before execution.
 */
export class RuntimeFleetHandoffRecoveryResolutionCatalog {
  constructor(
    private readonly audits: RuntimeFleetHandoffRecoveryAuditSource,
    private readonly reservations: RuntimeFleetHandoffRecoveryReservationController,
    private readonly admissions: RuntimeFleetHandoffRecoveryAdmissionSource,
    private readonly resolutions: RuntimeFleetHandoffRecoveryResolutionStore,
    private readonly clock: RuntimeFleetHandoffRecoveryResolutionClock = () => new Date(),
  ) {}

  async resolve(request: RuntimeFleetHandoffRecoveryResolutionRequest): Promise<RuntimeFleetHandoffRecoveryResolutionRecord> {
    validateRequest(request);
    if (await this.resolutions.get(request.resolutionId)) {
      throw new ConcurrencyError(`Runtime fleet handoff recovery resolution '${request.resolutionId}' already exists.`);
    }

    const audit = await this.audits.get(request.recoveryId);
    if (!audit) throw new MetadataError(`Unknown runtime fleet handoff recovery audit '${request.recoveryId}'.`);
    validateRuntimeFleetHandoffRecoveryAudit(audit);
    const decision = requireReviewDecision(audit, request.reservationId);

    const reservation = await this.reservations.get(request.reservationId);
    if (!reservation) throw new ConcurrencyError(`Runtime fleet fair reservation '${request.reservationId}' no longer exists.`);
    validateRuntimeFleetFairReservationRecord(reservation);
    assertDecisionReservationStillCurrent(decision, reservation);

    const admission = await this.admissions.get(decision.admissionId);
    if (admission) {
      validateRuntimeFleetFairDispatchRecord(admission);
      assertAdmissionMatchesReservation(reservation, admission);
    }
    assertDecisionAdmissionStillCurrent(decision, admission);

    return this.resolutions.create({
      format: "nublox-metaobject-runtime-fleet-handoff-recovery-resolution",
      formatVersion: 1,
      resolutionId: request.resolutionId,
      recoveryId: request.recoveryId,
      reservationId: decision.reservationId,
      reservationRevision: decision.reservationRevision,
      admissionId: decision.admissionId,
      dispatchId: decision.dispatchId,
      workerId: decision.workerId,
      handoffAt: decision.handoffAt,
      action: request.action,
      actorId: request.actorId,
      reason: request.reason,
      ...(decision.admissionStatus === undefined ? {} : {
        admissionStatus: decision.admissionStatus,
        admissionRevision: decision.admissionRevision,
      }),
      resolvedAt: this.clock().toISOString(),
    });
  }

  async execute(resolutionId: string): Promise<RuntimeFleetHandoffRecoveryResolutionExecutionResult> {
    assertText(resolutionId, "resolutionId");
    const resolution = await this.resolutions.get(resolutionId);
    if (!resolution) throw new MetadataError(`Unknown runtime fleet handoff recovery resolution '${resolutionId}'.`);
    validateRuntimeFleetHandoffRecoveryResolutionRecord(resolution);

    const reservation = await this.reservations.get(resolution.reservationId);
    if (!reservation) throw new ConcurrencyError(`Runtime fleet fair reservation '${resolution.reservationId}' no longer exists.`);
    validateRuntimeFleetFairReservationRecord(reservation);
    assertResolutionReservationStillCurrent(resolution, reservation);

    const admission = await this.admissions.get(resolution.admissionId);
    if (admission) {
      validateRuntimeFleetFairDispatchRecord(admission);
      assertAdmissionMatchesReservation(reservation, admission);
    }
    assertResolutionAdmissionStillCurrent(resolution, admission);

    if (resolution.action === "cancel") {
      const released = await this.reservations.release(
        resolution.reservationId,
        `M45 resolution '${resolution.resolutionId}' by '${resolution.actorId}': ${resolution.reason}`,
        reservation.revision,
      );
      return { outcome: "cancelled", resolution, reservation: released };
    }

    const resumed = await this.reservations.resume(resolution.reservationId);
    return {
      outcome: "resumed",
      resolution,
      reservation: resumed.reservation,
      ...(resumed.fairDispatch === undefined ? {} : { fairDispatch: resumed.fairDispatch }),
    };
  }

  async get(resolutionId: string): Promise<RuntimeFleetHandoffRecoveryResolutionRecord | null> {
    assertText(resolutionId, "resolutionId");
    return this.resolutions.get(resolutionId);
  }

  async history(
    filter: RuntimeFleetHandoffRecoveryResolutionFilter = {},
  ): Promise<readonly RuntimeFleetHandoffRecoveryResolutionRecord[]> {
    return this.resolutions.list(filter);
  }
}

function requireReviewDecision(
  audit: RuntimeFleetHandoffRecoveryAudit,
  reservationId: string,
): RuntimeFleetHandoffRecoveryDecision {
  const decision = audit.decisions.find((candidate) => candidate.reservationId === reservationId);
  if (!decision) {
    throw new MetadataError(`Recovery audit '${audit.recoveryId}' has no decision for reservation '${reservationId}'.`);
  }
  if (decision.action !== "review") {
    throw new MetadataError(
      `Recovery audit '${audit.recoveryId}' decision for reservation '${reservationId}' is '${decision.action}', not review.`,
    );
  }
  return decision;
}

function assertDecisionReservationStillCurrent(
  decision: RuntimeFleetHandoffRecoveryDecision,
  reservation: RuntimeFleetFairReservationRecord,
): void {
  if (reservation.status !== "handoff") {
    throw new ConcurrencyError(`Runtime fleet fair reservation '${reservation.reservationId}' changed from handoff to '${reservation.status}'.`);
  }
  if (
    reservation.revision !== decision.reservationRevision
    || reservation.admissionId !== decision.admissionId
    || reservation.dispatchId !== decision.dispatchId
    || reservation.workerId !== decision.workerId
    || reservation.handoffAt !== decision.handoffAt
  ) {
    throw new ConcurrencyError(`Runtime fleet fair reservation '${reservation.reservationId}' changed after M44 recovery audit.`);
  }
}

function assertResolutionReservationStillCurrent(
  resolution: RuntimeFleetHandoffRecoveryResolutionRecord,
  reservation: RuntimeFleetFairReservationRecord,
): void {
  if (reservation.status !== "handoff") {
    throw new ConcurrencyError(`Runtime fleet fair reservation '${reservation.reservationId}' changed from handoff to '${reservation.status}'.`);
  }
  if (
    reservation.revision !== resolution.reservationRevision
    || reservation.admissionId !== resolution.admissionId
    || reservation.dispatchId !== resolution.dispatchId
    || reservation.workerId !== resolution.workerId
    || reservation.handoffAt !== resolution.handoffAt
  ) {
    throw new ConcurrencyError(`Runtime fleet fair reservation '${reservation.reservationId}' changed after M45 recovery resolution.`);
  }
}

function assertDecisionAdmissionStillCurrent(
  decision: RuntimeFleetHandoffRecoveryDecision,
  admission: RuntimeFleetFairDispatchRecord | null,
): void {
  if (decision.admissionStatus === undefined) {
    if (admission !== null) throw new ConcurrencyError(`M40 admission '${decision.admissionId}' appeared after M44 recovery audit.`);
    return;
  }
  if (
    admission === null
    || admission.status !== decision.admissionStatus
    || admission.revision !== decision.admissionRevision
  ) {
    throw new ConcurrencyError(`M40 admission '${decision.admissionId}' changed after M44 recovery audit.`);
  }
}

function assertResolutionAdmissionStillCurrent(
  resolution: RuntimeFleetHandoffRecoveryResolutionRecord,
  admission: RuntimeFleetFairDispatchRecord | null,
): void {
  if (resolution.admissionStatus === undefined) {
    if (admission !== null) {
      throw new ConcurrencyError(`M40 admission '${resolution.admissionId}' appeared after M45 recovery resolution.`);
    }
    return;
  }
  if (
    admission === null
    || admission.status !== resolution.admissionStatus
    || admission.revision !== resolution.admissionRevision
  ) {
    throw new ConcurrencyError(`M40 admission '${resolution.admissionId}' changed after M45 recovery resolution.`);
  }
}

function assertAdmissionMatchesReservation(
  reservation: RuntimeFleetFairReservationRecord,
  admission: RuntimeFleetFairDispatchRecord,
): void {
  if (
    admission.admissionId !== reservation.admissionId
    || admission.fairnessId !== reservation.fairnessId
    || admission.dispatchId !== reservation.dispatchId
    || admission.workerId !== reservation.workerId
  ) {
    throw new MetadataError(`Runtime fleet fair reservation '${reservation.reservationId}' has mismatched M40 admission evidence.`);
  }
  const reservedIds = reservation.work.map((item) => item.workId);
  const admittedIds = admission.work.map((item) => item.workId);
  if (JSON.stringify(reservedIds) !== JSON.stringify(admittedIds)) {
    throw new MetadataError(`Runtime fleet fair reservation '${reservation.reservationId}' M40 work selection does not match the handoff.`);
  }
}

function validateRequest(request: RuntimeFleetHandoffRecoveryResolutionRequest): void {
  assertText(request.resolutionId, "resolutionId");
  assertText(request.recoveryId, "recoveryId");
  assertText(request.reservationId, "reservationId");
  assertText(request.actorId, "actorId");
  assertText(request.reason, "reason");
  if (request.action !== "resume" && request.action !== "cancel") {
    throw new MetadataError(`Invalid runtime fleet handoff recovery resolution action '${String(request.action)}'.`);
  }
}

export function validateRuntimeFleetHandoffRecoveryResolutionRecord(
  record: RuntimeFleetHandoffRecoveryResolutionRecord,
): void {
  if (record.format !== "nublox-metaobject-runtime-fleet-handoff-recovery-resolution" || record.formatVersion !== 1) {
    throw new MetadataError("Unsupported runtime fleet handoff recovery resolution format.");
  }
  for (const [label, value] of Object.entries({
    resolutionId: record.resolutionId,
    recoveryId: record.recoveryId,
    reservationId: record.reservationId,
    admissionId: record.admissionId,
    dispatchId: record.dispatchId,
    workerId: record.workerId,
    handoffAt: record.handoffAt,
    actorId: record.actorId,
    reason: record.reason,
    resolvedAt: record.resolvedAt,
  })) assertText(value, label);
  assertPositiveInteger(record.reservationRevision, "reservationRevision");
  if (record.action !== "resume" && record.action !== "cancel") {
    throw new MetadataError(`Invalid runtime fleet handoff recovery resolution action '${String(record.action)}'.`);
  }
  if (!Number.isFinite(Date.parse(record.handoffAt)) || !Number.isFinite(Date.parse(record.resolvedAt))) {
    throw new MetadataError("Runtime fleet handoff recovery resolution timestamps must be valid.");
  }
  if ((record.admissionStatus === undefined) !== (record.admissionRevision === undefined)) {
    throw new MetadataError("Runtime fleet handoff recovery resolution admissionStatus and admissionRevision must be supplied together.");
  }
  if (record.admissionRevision !== undefined) assertPositiveInteger(record.admissionRevision, "admissionRevision");
}

function assertText(value: string, label: string): void {
  if (!value.trim()) throw new MetadataError(`Runtime fleet handoff recovery resolution ${label} is required.`);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new MetadataError(`Runtime fleet handoff recovery resolution ${label} must be a positive integer.`);
  }
}
