import { ConcurrencyError, MetadataError } from "../errors/errors.js";
import type {
  RuntimeFleetFairDispatchRecord,
  RuntimeFleetFairDispatcher,
} from "./runtime-fleet-convergence-fair-dispatch.js";
import { validateRuntimeFleetFairDispatchRecord } from "./runtime-fleet-convergence-fair-dispatch.js";
import type {
  RuntimeFleetFairReservationDispatchResult,
  RuntimeFleetFairReservationFilter,
  RuntimeFleetFairReservationRecord,
} from "./runtime-fleet-convergence-fair-reservation.js";
import { validateRuntimeFleetFairReservationRecord } from "./runtime-fleet-convergence-fair-reservation.js";

export type RuntimeFleetHandoffRecoveryAction = "resume" | "cancel" | "review";

export interface RuntimeFleetHandoffRecoveryPolicyDefinition {
  readonly format: "nublox-metaobject-runtime-fleet-handoff-recovery-policy";
  readonly formatVersion: 1;
  readonly policyId: string;
  readonly version: number;
  /** Handoffs with no M40 evidence younger than this remain safe to resume. */
  readonly reviewAfterMs: number;
  /** Handoffs with no M40 evidence at or beyond this age become cancellation candidates. */
  readonly cancelAfterMs: number;
}

export interface RuntimeFleetHandoffRecoveryDecision {
  readonly reservationId: string;
  readonly reservationRevision: number;
  readonly admissionId: string;
  readonly dispatchId: string;
  readonly workerId: string;
  readonly handoffAt: string;
  readonly ageMs: number;
  readonly action: RuntimeFleetHandoffRecoveryAction;
  readonly reason: string;
  readonly admissionStatus?: RuntimeFleetFairDispatchRecord["status"];
  readonly admissionRevision?: number;
}

export interface RuntimeFleetHandoffRecoveryAudit {
  readonly format: "nublox-metaobject-runtime-fleet-handoff-recovery-audit";
  readonly formatVersion: 1;
  readonly recoveryId: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly decisions: readonly RuntimeFleetHandoffRecoveryDecision[];
  readonly total: number;
  readonly resume: number;
  readonly cancel: number;
  readonly review: number;
  readonly evaluatedAt: string;
}

export interface RuntimeFleetHandoffRecoveryFilter {
  readonly policyId?: string;
}

export interface RuntimeFleetHandoffRecoveryStore {
  get(recoveryId: string): Promise<RuntimeFleetHandoffRecoveryAudit | null>;
  list(filter?: RuntimeFleetHandoffRecoveryFilter): Promise<readonly RuntimeFleetHandoffRecoveryAudit[]>;
  create(record: RuntimeFleetHandoffRecoveryAudit): Promise<RuntimeFleetHandoffRecoveryAudit>;
}

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryRuntimeFleetHandoffRecoveryStore implements RuntimeFleetHandoffRecoveryStore {
  readonly #records = new Map<string, RuntimeFleetHandoffRecoveryAudit>();

  async get(recoveryId: string): Promise<RuntimeFleetHandoffRecoveryAudit | null> {
    const record = this.#records.get(recoveryId);
    return record ? clone(record) : null;
  }

  async list(filter: RuntimeFleetHandoffRecoveryFilter = {}): Promise<readonly RuntimeFleetHandoffRecoveryAudit[]> {
    return [...this.#records.values()]
      .filter((record) => filter.policyId === undefined || record.policyId === filter.policyId)
      .sort((left, right) => left.evaluatedAt.localeCompare(right.evaluatedAt) || left.recoveryId.localeCompare(right.recoveryId))
      .map(clone);
  }

  async create(record: RuntimeFleetHandoffRecoveryAudit): Promise<RuntimeFleetHandoffRecoveryAudit> {
    validateRuntimeFleetHandoffRecoveryAudit(record);
    if (this.#records.has(record.recoveryId)) {
      throw new ConcurrencyError(`Runtime fleet handoff recovery audit '${record.recoveryId}' already exists.`);
    }
    const stored = clone(record);
    this.#records.set(stored.recoveryId, stored);
    return clone(stored);
  }
}

export interface RuntimeFleetHandoffRecoveryReservationController {
  get(reservationId: string): Promise<RuntimeFleetFairReservationRecord | null>;
  history(filter?: RuntimeFleetFairReservationFilter): Promise<readonly RuntimeFleetFairReservationRecord[]>;
  resume(reservationId: string): Promise<RuntimeFleetFairReservationDispatchResult>;
  release(reservationId: string, reason: string, expectedRevision: number): Promise<RuntimeFleetFairReservationRecord>;
}

export interface RuntimeFleetHandoffRecoveryAdmissionSource {
  get(admissionId: string): Promise<RuntimeFleetFairDispatchRecord | null>;
}

export interface RuntimeFleetHandoffRecoveryAuditRequest {
  readonly recoveryId: string;
  readonly policy: RuntimeFleetHandoffRecoveryPolicyDefinition;
  /** Optional exact reservation subset. Every supplied reservation must still be in handoff state. */
  readonly reservationIds?: readonly string[];
}

export type RuntimeFleetHandoffRecoveryExecutionOutcome = "resumed" | "cancelled" | "review-required";

export interface RuntimeFleetHandoffRecoveryExecutionResult {
  readonly outcome: RuntimeFleetHandoffRecoveryExecutionOutcome;
  readonly decision: RuntimeFleetHandoffRecoveryDecision;
  readonly reservation: RuntimeFleetFairReservationRecord;
  readonly fairDispatch?: RuntimeFleetFairReservationDispatchResult["fairDispatch"];
}

export type RuntimeFleetHandoffRecoveryClock = () => Date;

/**
 * Audit and explicitly recover M42 handoffs using immutable M43 fencing evidence.
 * M44 never runs on a timer: callers choose when to audit and when to execute a
 * recorded decision. Every execution revalidates the exact reservation/admission
 * revisions captured by the audit before invoking M41/M42 recovery operations.
 */
export class RuntimeFleetHandoffRecoveryCatalog {
  constructor(
    private readonly reservations: RuntimeFleetHandoffRecoveryReservationController,
    private readonly admissions: RuntimeFleetHandoffRecoveryAdmissionSource,
    private readonly recoveries: RuntimeFleetHandoffRecoveryStore,
    private readonly clock: RuntimeFleetHandoffRecoveryClock = () => new Date(),
  ) {}

  async audit(request: RuntimeFleetHandoffRecoveryAuditRequest): Promise<RuntimeFleetHandoffRecoveryAudit> {
    assertText(request.recoveryId, "recoveryId");
    validateRuntimeFleetHandoffRecoveryPolicy(request.policy);
    if (await this.recoveries.get(request.recoveryId)) {
      throw new ConcurrencyError(`Runtime fleet handoff recovery audit '${request.recoveryId}' already exists.`);
    }

    const evaluatedAt = this.clock();
    const reservations = await this.selectReservations(request.reservationIds);
    const decisions: RuntimeFleetHandoffRecoveryDecision[] = [];
    for (const reservation of reservations) {
      const admission = await this.admissions.get(reservation.admissionId);
      if (admission) {
        validateRuntimeFleetFairDispatchRecord(admission);
        assertAdmissionMatchesReservation(reservation, admission);
      }
      decisions.push(classify(reservation, admission, request.policy, evaluatedAt));
    }

    const record: RuntimeFleetHandoffRecoveryAudit = {
      format: "nublox-metaobject-runtime-fleet-handoff-recovery-audit",
      formatVersion: 1,
      recoveryId: request.recoveryId,
      policyId: request.policy.policyId,
      policyVersion: request.policy.version,
      decisions,
      total: decisions.length,
      resume: decisions.filter((decision) => decision.action === "resume").length,
      cancel: decisions.filter((decision) => decision.action === "cancel").length,
      review: decisions.filter((decision) => decision.action === "review").length,
      evaluatedAt: evaluatedAt.toISOString(),
    };
    return this.recoveries.create(record);
  }

  async execute(recoveryId: string, reservationId: string): Promise<RuntimeFleetHandoffRecoveryExecutionResult> {
    assertText(recoveryId, "recoveryId");
    assertText(reservationId, "reservationId");
    const audit = await this.recoveries.get(recoveryId);
    if (!audit) throw new MetadataError(`Unknown runtime fleet handoff recovery audit '${recoveryId}'.`);
    validateRuntimeFleetHandoffRecoveryAudit(audit);
    const decision = audit.decisions.find((candidate) => candidate.reservationId === reservationId);
    if (!decision) {
      throw new MetadataError(`Recovery audit '${recoveryId}' has no decision for reservation '${reservationId}'.`);
    }

    const reservation = await this.reservations.get(reservationId);
    if (!reservation) throw new ConcurrencyError(`Runtime fleet fair reservation '${reservationId}' no longer exists.`);
    validateRuntimeFleetFairReservationRecord(reservation);
    assertDecisionReservationStillCurrent(decision, reservation);

    const admission = await this.admissions.get(decision.admissionId);
    if (admission) {
      validateRuntimeFleetFairDispatchRecord(admission);
      assertAdmissionMatchesReservation(reservation, admission);
    }
    assertDecisionAdmissionStillCurrent(decision, admission);

    if (decision.action === "review") {
      return { outcome: "review-required", decision, reservation };
    }
    if (decision.action === "cancel") {
      const released = await this.reservations.release(
        reservation.reservationId,
        `M44 recovery '${recoveryId}': ${decision.reason}`,
        reservation.revision,
      );
      return { outcome: "cancelled", decision, reservation: released };
    }

    const resumed = await this.reservations.resume(reservation.reservationId);
    return {
      outcome: "resumed",
      decision,
      reservation: resumed.reservation,
      ...(resumed.fairDispatch === undefined ? {} : { fairDispatch: resumed.fairDispatch }),
    };
  }

  async get(recoveryId: string): Promise<RuntimeFleetHandoffRecoveryAudit | null> {
    assertText(recoveryId, "recoveryId");
    return this.recoveries.get(recoveryId);
  }

  async history(filter: RuntimeFleetHandoffRecoveryFilter = {}): Promise<readonly RuntimeFleetHandoffRecoveryAudit[]> {
    return this.recoveries.list(filter);
  }

  private async selectReservations(reservationIds?: readonly string[]): Promise<readonly RuntimeFleetFairReservationRecord[]> {
    if (reservationIds === undefined) {
      const records = await this.reservations.history({ status: "handoff" });
      return [...records]
        .map((record) => {
          validateRuntimeFleetFairReservationRecord(record);
          return record;
        })
        .sort(compareReservations);
    }

    if (reservationIds.length === 0) throw new MetadataError("Runtime fleet handoff recovery reservationIds cannot be empty.");
    const seen = new Set<string>();
    const selected: RuntimeFleetFairReservationRecord[] = [];
    for (const reservationId of reservationIds) {
      assertText(reservationId, "reservationId");
      if (seen.has(reservationId)) {
        throw new MetadataError(`Runtime fleet handoff recovery contains duplicate reservation '${reservationId}'.`);
      }
      seen.add(reservationId);
      const reservation = await this.reservations.get(reservationId);
      if (!reservation) throw new MetadataError(`Unknown runtime fleet fair reservation '${reservationId}'.`);
      validateRuntimeFleetFairReservationRecord(reservation);
      if (reservation.status !== "handoff") {
        throw new ConcurrencyError(`Runtime fleet fair reservation '${reservationId}' is '${reservation.status}', not handoff.`);
      }
      selected.push(reservation);
    }
    return selected.sort(compareReservations);
  }
}

function classify(
  reservation: RuntimeFleetFairReservationRecord,
  admission: RuntimeFleetFairDispatchRecord | null,
  policy: RuntimeFleetHandoffRecoveryPolicyDefinition,
  evaluatedAt: Date,
): RuntimeFleetHandoffRecoveryDecision {
  if (reservation.status !== "handoff" || !reservation.handoffAt) {
    throw new MetadataError(`Runtime fleet fair reservation '${reservation.reservationId}' is not an auditable handoff.`);
  }
  const handoffAt = Date.parse(reservation.handoffAt);
  const evaluatedAtMs = evaluatedAt.getTime();
  if (!Number.isFinite(handoffAt) || handoffAt > evaluatedAtMs) {
    throw new MetadataError(`Runtime fleet fair reservation '${reservation.reservationId}' has invalid future handoffAt.`);
  }
  const ageMs = evaluatedAtMs - handoffAt;

  let action: RuntimeFleetHandoffRecoveryAction;
  let reason: string;
  if (admission?.status === "cancelled") {
    action = "cancel";
    reason = "M40 cancellation fence already exists; finalize the M41/M42 release.";
  } else if (admission) {
    action = "resume";
    reason = `M40 admission is '${admission.status}' and must be reconciled through the existing handoff.`;
  } else if (ageMs >= policy.cancelAfterMs) {
    action = "cancel";
    reason = `No M40 admission exists and handoff age ${ageMs}ms reached the ${policy.cancelAfterMs}ms cancellation threshold.`;
  } else if (ageMs >= policy.reviewAfterMs) {
    action = "review";
    reason = `No M40 admission exists and handoff age ${ageMs}ms reached the ${policy.reviewAfterMs}ms review threshold.`;
  } else {
    action = "resume";
    reason = `No M40 admission exists and handoff age ${ageMs}ms remains inside the ${policy.reviewAfterMs}ms resume window.`;
  }

  return {
    reservationId: reservation.reservationId,
    reservationRevision: reservation.revision,
    admissionId: reservation.admissionId,
    dispatchId: reservation.dispatchId,
    workerId: reservation.workerId,
    handoffAt: reservation.handoffAt,
    ageMs,
    action,
    reason,
    ...(admission === null ? {} : {
      admissionStatus: admission.status,
      admissionRevision: admission.revision,
    }),
  };
}

function compareReservations(left: RuntimeFleetFairReservationRecord, right: RuntimeFleetFairReservationRecord): number {
  return (left.handoffAt ?? "").localeCompare(right.handoffAt ?? "") || left.reservationId.localeCompare(right.reservationId);
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

function assertDecisionAdmissionStillCurrent(
  decision: RuntimeFleetHandoffRecoveryDecision,
  admission: RuntimeFleetFairDispatchRecord | null,
): void {
  if (decision.admissionStatus === undefined) {
    if (admission !== null) {
      throw new ConcurrencyError(`M40 admission '${decision.admissionId}' appeared after M44 recovery audit.`);
    }
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

export function validateRuntimeFleetHandoffRecoveryPolicy(policy: RuntimeFleetHandoffRecoveryPolicyDefinition): void {
  if (policy.format !== "nublox-metaobject-runtime-fleet-handoff-recovery-policy" || policy.formatVersion !== 1) {
    throw new MetadataError("Unsupported runtime fleet handoff recovery policy format.");
  }
  assertText(policy.policyId, "policyId");
  assertPositiveInteger(policy.version, "policy version");
  assertPositiveInteger(policy.reviewAfterMs, "reviewAfterMs");
  assertPositiveInteger(policy.cancelAfterMs, "cancelAfterMs");
  if (policy.cancelAfterMs <= policy.reviewAfterMs) {
    throw new MetadataError("Runtime fleet handoff recovery cancelAfterMs must be greater than reviewAfterMs.");
  }
}

export function validateRuntimeFleetHandoffRecoveryAudit(record: RuntimeFleetHandoffRecoveryAudit): void {
  if (record.format !== "nublox-metaobject-runtime-fleet-handoff-recovery-audit" || record.formatVersion !== 1) {
    throw new MetadataError("Unsupported runtime fleet handoff recovery audit format.");
  }
  assertText(record.recoveryId, "recoveryId");
  assertText(record.policyId, "policyId");
  assertPositiveInteger(record.policyVersion, "policyVersion");
  if (!Number.isFinite(Date.parse(record.evaluatedAt))) {
    throw new MetadataError("Runtime fleet handoff recovery evaluatedAt must be a valid timestamp.");
  }
  const ids = new Set<string>();
  let resume = 0;
  let cancel = 0;
  let review = 0;
  for (const decision of record.decisions) {
    assertText(decision.reservationId, "reservationId");
    assertText(decision.admissionId, "admissionId");
    assertText(decision.dispatchId, "dispatchId");
    assertText(decision.workerId, "workerId");
    assertText(decision.reason, "reason");
    assertPositiveInteger(decision.reservationRevision, "reservationRevision");
    if (!Number.isSafeInteger(decision.ageMs) || decision.ageMs < 0) {
      throw new MetadataError("Runtime fleet handoff recovery ageMs must be a non-negative integer.");
    }
    if (!Number.isFinite(Date.parse(decision.handoffAt))) {
      throw new MetadataError("Runtime fleet handoff recovery handoffAt must be a valid timestamp.");
    }
    if (decision.action !== "resume" && decision.action !== "cancel" && decision.action !== "review") {
      throw new MetadataError(`Invalid runtime fleet handoff recovery action '${String(decision.action)}'.`);
    }
    if ((decision.admissionStatus === undefined) !== (decision.admissionRevision === undefined)) {
      throw new MetadataError("Runtime fleet handoff recovery admissionStatus and admissionRevision must be supplied together.");
    }
    if (decision.admissionRevision !== undefined) assertPositiveInteger(decision.admissionRevision, "admissionRevision");
    if (ids.has(decision.reservationId)) {
      throw new MetadataError(`Runtime fleet handoff recovery contains duplicate reservation '${decision.reservationId}'.`);
    }
    ids.add(decision.reservationId);
    if (decision.action === "resume") resume += 1;
    if (decision.action === "cancel") cancel += 1;
    if (decision.action === "review") review += 1;
  }
  if (
    record.total !== record.decisions.length
    || record.resume !== resume
    || record.cancel !== cancel
    || record.review !== review
    || record.total !== record.resume + record.cancel + record.review
  ) {
    throw new MetadataError("Runtime fleet handoff recovery summary counts do not match decisions.");
  }
}

function assertText(value: string, label: string): void {
  if (!value.trim()) throw new MetadataError(`Runtime fleet handoff recovery ${label} is required.`);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new MetadataError(`Runtime fleet handoff recovery ${label} must be a positive integer.`);
  }
}
