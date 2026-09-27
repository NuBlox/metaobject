import { ConcurrencyError, MetadataError } from "../errors/errors.js";
import type {
  RuntimeFleetFairDispatchRecord,
  RuntimeFleetFairDispatchResult,
  RuntimeFleetFairDispatcher,
} from "./runtime-fleet-convergence-fair-dispatch.js";
import type {
  RuntimeFleetConvergenceFairnessDecision,
  RuntimeFleetConvergenceFairnessEvaluation,
} from "./runtime-fleet-convergence-fairness.js";
import { validateRuntimeFleetConvergenceFairnessEvaluation } from "./runtime-fleet-convergence-fairness.js";
import type {
  RuntimeFleetConvergenceCatalog,
  RuntimeFleetConvergenceWorkItem,
} from "./runtime-fleet-convergence.js";

export type RuntimeFleetFairReservationStatus = "active" | "consumed" | "released";

export interface RuntimeFleetFairReservationWork {
  readonly workId: string;
  readonly runtimeId: string;
  readonly action: RuntimeFleetConvergenceWorkItem["action"];
  readonly workRevision: number;
  readonly fairnessRank: number;
}

export interface RuntimeFleetFairReservationRecord {
  readonly format: "nublox-metaobject-runtime-fleet-fair-reservation";
  readonly formatVersion: 1;
  readonly reservationId: string;
  readonly revision: number;
  readonly status: RuntimeFleetFairReservationStatus;
  readonly fairnessId: string;
  readonly fairnessPolicyId: string;
  readonly fairnessPolicyVersion: number;
  readonly sourceEvaluationId: string;
  readonly admissionId: string;
  readonly dispatchId: string;
  readonly workerId: string;
  readonly work: readonly RuntimeFleetFairReservationWork[];
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly fairAdmissionStatus?: RuntimeFleetFairDispatchRecord["status"];
  readonly dispatchOutcome?: RuntimeFleetFairDispatchRecord["dispatchOutcome"];
  readonly finishedAt?: string;
  readonly reason?: string;
}

export interface RuntimeFleetFairReservationFilter {
  readonly status?: RuntimeFleetFairReservationStatus;
  readonly workerId?: string;
  readonly fairnessPolicyId?: string;
}

/**
 * acquire() must atomically reject overlap with every unexpired active lease.
 * Implementations may retain expired active records as immutable historical state;
 * they simply stop participating in exclusivity checks after expiresAt.
 */
export interface RuntimeFleetFairReservationStore {
  get(reservationId: string): Promise<RuntimeFleetFairReservationRecord | null>;
  list(filter?: RuntimeFleetFairReservationFilter): Promise<readonly RuntimeFleetFairReservationRecord[]>;
  acquire(record: RuntimeFleetFairReservationRecord): Promise<RuntimeFleetFairReservationRecord>;
  save(record: RuntimeFleetFairReservationRecord, expectedRevision: number): Promise<RuntimeFleetFairReservationRecord>;
}

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryRuntimeFleetFairReservationStore implements RuntimeFleetFairReservationStore {
  readonly #records = new Map<string, RuntimeFleetFairReservationRecord>();

  async get(reservationId: string): Promise<RuntimeFleetFairReservationRecord | null> {
    const record = this.#records.get(reservationId);
    return record ? clone(record) : null;
  }

  async list(filter: RuntimeFleetFairReservationFilter = {}): Promise<readonly RuntimeFleetFairReservationRecord[]> {
    return [...this.#records.values()]
      .filter((record) => filter.status === undefined || record.status === filter.status)
      .filter((record) => filter.workerId === undefined || record.workerId === filter.workerId)
      .filter((record) => filter.fairnessPolicyId === undefined || record.fairnessPolicyId === filter.fairnessPolicyId)
      .sort((left, right) => left.acquiredAt.localeCompare(right.acquiredAt) || left.reservationId.localeCompare(right.reservationId))
      .map(clone);
  }

  async acquire(record: RuntimeFleetFairReservationRecord): Promise<RuntimeFleetFairReservationRecord> {
    validateRuntimeFleetFairReservationRecord(record);
    if (record.status !== "active" || record.revision !== 0) {
      throw new MetadataError("New runtime fleet fair reservations must be active at revision zero.");
    }
    if (this.#records.has(record.reservationId)) {
      throw new ConcurrencyError(`Runtime fleet fair reservation '${record.reservationId}' already exists.`);
    }

    const acquiredAtMs = Date.parse(record.acquiredAt);
    const requested = new Set(record.work.map((item) => item.workId));
    for (const existing of this.#records.values()) {
      if (existing.status !== "active") continue;
      const expiresAtMs = Date.parse(existing.expiresAt);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= acquiredAtMs) continue;
      const conflict = existing.work.find((item) => requested.has(item.workId));
      if (conflict) {
        throw new ConcurrencyError(
          `Runtime fleet convergence work '${conflict.workId}' is reserved by '${existing.reservationId}' until ${existing.expiresAt}.`,
        );
      }
    }

    const stored = clone({ ...record, revision: 1 });
    this.#records.set(stored.reservationId, stored);
    return clone(stored);
  }

  async save(record: RuntimeFleetFairReservationRecord, expectedRevision: number): Promise<RuntimeFleetFairReservationRecord> {
    validateRuntimeFleetFairReservationRecord(record);
    const current = this.#records.get(record.reservationId);
    if (!current) throw new MetadataError(`Unknown runtime fleet fair reservation '${record.reservationId}'.`);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new MetadataError("Runtime fleet fair reservation expectedRevision must be a positive integer.");
    }
    if (current.revision !== expectedRevision) {
      throw new ConcurrencyError(
        `Runtime fleet fair reservation conflict for '${record.reservationId}': expected revision ${expectedRevision}, found ${current.revision}.`,
      );
    }
    if (current.status !== "active") {
      throw new MetadataError(`Terminal runtime fleet fair reservation '${record.reservationId}' is immutable.`);
    }
    for (const [label, before, after] of [
      ["fairnessId", current.fairnessId, record.fairnessId],
      ["fairnessPolicyId", current.fairnessPolicyId, record.fairnessPolicyId],
      ["fairnessPolicyVersion", current.fairnessPolicyVersion, record.fairnessPolicyVersion],
      ["sourceEvaluationId", current.sourceEvaluationId, record.sourceEvaluationId],
      ["admissionId", current.admissionId, record.admissionId],
      ["dispatchId", current.dispatchId, record.dispatchId],
      ["workerId", current.workerId, record.workerId],
      ["acquiredAt", current.acquiredAt, record.acquiredAt],
      ["expiresAt", current.expiresAt, record.expiresAt],
    ] as const) {
      if (before !== after) throw new MetadataError(`Runtime fleet fair reservation '${record.reservationId}' ${label} is immutable.`);
    }
    if (JSON.stringify(current.work) !== JSON.stringify(record.work)) {
      throw new MetadataError(`Runtime fleet fair reservation '${record.reservationId}' work selection is immutable.`);
    }

    const stored = clone({ ...record, revision: current.revision + 1 });
    this.#records.set(stored.reservationId, stored);
    return clone(stored);
  }
}

export interface RuntimeFleetFairReservationFairnessSource {
  get(fairnessId: string): Promise<RuntimeFleetConvergenceFairnessEvaluation | null>;
}

export interface RuntimeFleetFairReservationRequest {
  readonly reservationId: string;
  readonly fairnessId: string;
  readonly admissionId: string;
  readonly dispatchId: string;
  readonly workerId: string;
  readonly leaseMs: number;
  /** Maximum ranked items protected by this lease. Defaults to 100. */
  readonly maxItems?: number;
}

export interface RuntimeFleetFairReservationDispatchResult {
  readonly reservation: RuntimeFleetFairReservationRecord;
  readonly fairDispatch?: RuntimeFleetFairDispatchResult;
}

export type RuntimeFleetFairReservationClock = () => Date;

/**
 * Atomically reserve the exact M39-ranked work set before M40 admission.
 * The lease closes the window in which concurrent callers could both validate
 * the same pending M34 work before either M36 path claims it.
 */
export class RuntimeFleetFairReservationCatalog {
  constructor(
    private readonly fairness: RuntimeFleetFairReservationFairnessSource,
    private readonly convergence: RuntimeFleetConvergenceCatalog,
    private readonly reservations: RuntimeFleetFairReservationStore,
    private readonly fairDispatcher: RuntimeFleetFairDispatcher,
    private readonly clock: RuntimeFleetFairReservationClock = () => new Date(),
  ) {}

  async reserve(request: RuntimeFleetFairReservationRequest): Promise<RuntimeFleetFairReservationRecord> {
    for (const [label, value] of Object.entries({
      reservationId: request.reservationId,
      fairnessId: request.fairnessId,
      admissionId: request.admissionId,
      dispatchId: request.dispatchId,
      workerId: request.workerId,
    })) assertText(value, label);
    assertPositiveInteger(request.leaseMs, "leaseMs");
    const maxItems = request.maxItems ?? 100;
    assertPositiveInteger(maxItems, "maxItems");
    if (await this.reservations.get(request.reservationId)) {
      throw new ConcurrencyError(`Runtime fleet fair reservation '${request.reservationId}' already exists.`);
    }

    const evaluation = await this.requireFairness(request.fairnessId);
    const selectedIds = evaluation.orderedWorkIds.slice(0, maxItems);
    if (selectedIds.length === 0) {
      throw new MetadataError(`Runtime fleet convergence fairness evaluation '${request.fairnessId}' has no work to reserve.`);
    }
    const work = await this.revalidateSelection(evaluation, selectedIds);
    const acquired = this.clock();
    const acquiredAt = acquired.toISOString();
    const expiresAt = new Date(acquired.getTime() + request.leaseMs).toISOString();

    return this.reservations.acquire({
      format: "nublox-metaobject-runtime-fleet-fair-reservation",
      formatVersion: 1,
      reservationId: request.reservationId,
      revision: 0,
      status: "active",
      fairnessId: evaluation.fairnessId,
      fairnessPolicyId: evaluation.fairnessPolicyId,
      fairnessPolicyVersion: evaluation.fairnessPolicyVersion,
      sourceEvaluationId: evaluation.sourceEvaluationId,
      admissionId: request.admissionId,
      dispatchId: request.dispatchId,
      workerId: request.workerId,
      work,
      acquiredAt,
      expiresAt,
    });
  }

  async dispatch(reservationId: string): Promise<RuntimeFleetFairReservationDispatchResult> {
    const reservation = await this.requireReservation(reservationId);
    if (reservation.status !== "active") return { reservation };

    const existingAdmission = await this.fairDispatcher.get(reservation.admissionId);
    if (existingAdmission) return this.resume(reservationId);

    this.assertUnexpired(reservation);
    await this.revalidateReservedWork(reservation);
    const fairDispatch = await this.fairDispatcher.dispatch({
      admissionId: reservation.admissionId,
      fairnessId: reservation.fairnessId,
      dispatchId: reservation.dispatchId,
      workerId: reservation.workerId,
      maxItems: reservation.work.length,
    });
    const consumed = await this.consume(reservation, fairDispatch.admission);
    return { reservation: consumed, fairDispatch };
  }

  async resume(reservationId: string): Promise<RuntimeFleetFairReservationDispatchResult> {
    const reservation = await this.requireReservation(reservationId);
    if (reservation.status !== "active") return { reservation };

    const existingAdmission = await this.fairDispatcher.get(reservation.admissionId);
    if (!existingAdmission) {
      this.assertUnexpired(reservation);
      return this.dispatch(reservationId);
    }
    this.assertMatchingAdmission(reservation, existingAdmission);
    const fairDispatch = await this.fairDispatcher.resume(reservation.admissionId);
    const consumed = await this.consume(reservation, fairDispatch.admission);
    return { reservation: consumed, fairDispatch };
  }

  async release(reservationId: string, reason: string, expectedRevision: number): Promise<RuntimeFleetFairReservationRecord> {
    assertText(reason, "release reason");
    const reservation = await this.requireReservation(reservationId);
    if (reservation.status !== "active") {
      throw new MetadataError(`Runtime fleet fair reservation '${reservationId}' is '${reservation.status}' and cannot be released.`);
    }
    if (await this.fairDispatcher.get(reservation.admissionId)) {
      throw new MetadataError(
        `Runtime fleet fair reservation '${reservationId}' already has M40 admission '${reservation.admissionId}' and must be resumed instead of released.`,
      );
    }
    return this.reservations.save({
      ...reservation,
      status: "released",
      reason,
      finishedAt: this.clock().toISOString(),
    }, expectedRevision);
  }

  async get(reservationId: string): Promise<RuntimeFleetFairReservationRecord | null> {
    assertText(reservationId, "reservationId");
    return this.reservations.get(reservationId);
  }

  async history(filter: RuntimeFleetFairReservationFilter = {}): Promise<readonly RuntimeFleetFairReservationRecord[]> {
    return this.reservations.list(filter);
  }

  private async consume(
    reservation: RuntimeFleetFairReservationRecord,
    admission: RuntimeFleetFairDispatchRecord,
  ): Promise<RuntimeFleetFairReservationRecord> {
    this.assertMatchingAdmission(reservation, admission);
    return this.reservations.save({
      ...reservation,
      status: "consumed",
      fairAdmissionStatus: admission.status,
      ...(admission.dispatchOutcome === undefined ? {} : { dispatchOutcome: admission.dispatchOutcome }),
      ...(admission.status === "failed" && admission.error !== undefined ? { reason: admission.error } : {}),
      finishedAt: this.clock().toISOString(),
    }, reservation.revision);
  }

  private assertMatchingAdmission(
    reservation: RuntimeFleetFairReservationRecord,
    admission: RuntimeFleetFairDispatchRecord,
  ): void {
    if (
      admission.admissionId !== reservation.admissionId
      || admission.fairnessId !== reservation.fairnessId
      || admission.dispatchId !== reservation.dispatchId
      || admission.workerId !== reservation.workerId
    ) {
      throw new MetadataError(`Runtime fleet fair reservation '${reservation.reservationId}' is linked to mismatched M40 admission evidence.`);
    }
    const reservedIds = reservation.work.map((item) => item.workId);
    const admittedIds = admission.work.map((item) => item.workId);
    if (JSON.stringify(reservedIds) !== JSON.stringify(admittedIds)) {
      throw new MetadataError(`Runtime fleet fair reservation '${reservation.reservationId}' M40 work selection does not match the lease.`);
    }
  }

  private assertUnexpired(reservation: RuntimeFleetFairReservationRecord): void {
    const now = this.clock().getTime();
    const expiresAt = Date.parse(reservation.expiresAt);
    if (!Number.isFinite(expiresAt) || now >= expiresAt) {
      throw new ConcurrencyError(`Runtime fleet fair reservation '${reservation.reservationId}' expired at ${reservation.expiresAt}.`);
    }
  }

  private async requireFairness(fairnessId: string): Promise<RuntimeFleetConvergenceFairnessEvaluation> {
    const evaluation = await this.fairness.get(fairnessId);
    if (!evaluation) throw new MetadataError(`Unknown runtime fleet convergence fairness evaluation '${fairnessId}'.`);
    validateRuntimeFleetConvergenceFairnessEvaluation(evaluation);
    return evaluation;
  }

  private async requireReservation(reservationId: string): Promise<RuntimeFleetFairReservationRecord> {
    assertText(reservationId, "reservationId");
    const reservation = await this.reservations.get(reservationId);
    if (!reservation) throw new MetadataError(`Unknown runtime fleet fair reservation '${reservationId}'.`);
    return reservation;
  }

  private async revalidateSelection(
    evaluation: RuntimeFleetConvergenceFairnessEvaluation,
    workIds: readonly string[],
  ): Promise<readonly RuntimeFleetFairReservationWork[]> {
    const decisions = new Map(evaluation.decisions.map((decision) => [decision.workId, decision] as const));
    const result: RuntimeFleetFairReservationWork[] = [];
    for (const workId of workIds) {
      const decision = decisions.get(workId);
      if (!decision) throw new MetadataError(`Runtime fleet fair reservation fairness decision '${workId}' is missing.`);
      const work = await this.convergence.get(workId);
      if (!work) throw new ConcurrencyError(`Runtime fleet convergence work '${workId}' no longer exists.`);
      assertExactWork(work, decision);
      result.push({
        workId: work.workId,
        runtimeId: work.runtimeId,
        action: work.action,
        workRevision: work.revision,
        fairnessRank: decision.rank,
      });
    }
    return result;
  }

  private async revalidateReservedWork(reservation: RuntimeFleetFairReservationRecord): Promise<void> {
    for (const leased of reservation.work) {
      const work = await this.convergence.get(leased.workId);
      if (!work) throw new ConcurrencyError(`Runtime fleet convergence work '${leased.workId}' no longer exists.`);
      if (work.status !== "pending") {
        throw new ConcurrencyError(`Runtime fleet convergence work '${leased.workId}' is '${work.status}' and the reservation is stale.`);
      }
      if (work.revision !== leased.workRevision || work.runtimeId !== leased.runtimeId || work.action !== leased.action) {
        throw new ConcurrencyError(`Runtime fleet convergence work '${leased.workId}' changed after reservation acquisition.`);
      }
    }
  }
}

function assertExactWork(work: RuntimeFleetConvergenceWorkItem, decision: RuntimeFleetConvergenceFairnessDecision): void {
  if (work.status !== "pending") {
    throw new ConcurrencyError(`Runtime fleet convergence work '${work.workId}' is '${work.status}' and cannot be reserved.`);
  }
  if (work.revision !== decision.workRevision) {
    throw new ConcurrencyError(
      `Runtime fleet convergence work '${work.workId}' changed from fairness revision ${decision.workRevision} to ${work.revision}.`,
    );
  }
  if (work.runtimeId !== decision.runtimeId || work.action !== decision.action) {
    throw new ConcurrencyError(`Runtime fleet convergence work '${work.workId}' identity changed after M39 fairness evaluation.`);
  }
}

function assertText(value: string, label: string): void {
  if (!value.trim()) throw new MetadataError(`Runtime fleet fair reservation ${label} is required.`);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new MetadataError(`Runtime fleet fair reservation ${label} must be a positive integer.`);
  }
}

const validStatuses = new Set<RuntimeFleetFairReservationStatus>(["active", "consumed", "released"]);

export function validateRuntimeFleetFairReservationRecord(record: RuntimeFleetFairReservationRecord): void {
  if (record.format !== "nublox-metaobject-runtime-fleet-fair-reservation" || record.formatVersion !== 1) {
    throw new MetadataError("Unsupported runtime fleet fair reservation format.");
  }
  for (const [label, value] of Object.entries({
    reservationId: record.reservationId,
    fairnessId: record.fairnessId,
    fairnessPolicyId: record.fairnessPolicyId,
    sourceEvaluationId: record.sourceEvaluationId,
    admissionId: record.admissionId,
    dispatchId: record.dispatchId,
    workerId: record.workerId,
    acquiredAt: record.acquiredAt,
    expiresAt: record.expiresAt,
  })) assertText(value, label);
  if (!Number.isSafeInteger(record.revision) || record.revision < 0) {
    throw new MetadataError("Runtime fleet fair reservation revision must be a non-negative integer.");
  }
  assertPositiveInteger(record.fairnessPolicyVersion, "fairnessPolicyVersion");
  if (!validStatuses.has(record.status)) throw new MetadataError(`Invalid runtime fleet fair reservation status '${String(record.status)}'.`);
  const acquired = Date.parse(record.acquiredAt);
  const expires = Date.parse(record.expiresAt);
  if (!Number.isFinite(acquired) || !Number.isFinite(expires) || expires <= acquired) {
    throw new MetadataError("Runtime fleet fair reservation expiresAt must be later than acquiredAt.");
  }
  if (record.work.length === 0) throw new MetadataError("Runtime fleet fair reservation requires at least one work item.");
  const workIds = new Set<string>();
  let previousRank = 0;
  for (const item of record.work) {
    assertText(item.workId, "workId");
    assertText(item.runtimeId, "runtimeId");
    assertPositiveInteger(item.workRevision, "workRevision");
    assertPositiveInteger(item.fairnessRank, "fairnessRank");
    if (item.fairnessRank <= previousRank) {
      throw new MetadataError("Runtime fleet fair reservation work must preserve ascending fairness rank.");
    }
    previousRank = item.fairnessRank;
    if (workIds.has(item.workId)) throw new MetadataError(`Runtime fleet fair reservation contains duplicate work '${item.workId}'.`);
    workIds.add(item.workId);
  }

  if (record.status === "active") {
    if (
      record.fairAdmissionStatus !== undefined
      || record.dispatchOutcome !== undefined
      || record.finishedAt !== undefined
      || record.reason !== undefined
    ) {
      throw new MetadataError("Active runtime fleet fair reservation cannot contain terminal state.");
    }
  } else if (record.status === "consumed") {
    if (record.fairAdmissionStatus === undefined || !record.finishedAt?.trim()) {
      throw new MetadataError("Consumed runtime fleet fair reservation requires fairAdmissionStatus and finishedAt.");
    }
    if (record.fairAdmissionStatus === "completed" && record.dispatchOutcome === undefined) {
      throw new MetadataError("Consumed reservation for completed M40 admission requires dispatchOutcome.");
    }
  } else {
    if (!record.finishedAt?.trim() || !record.reason?.trim()) {
      throw new MetadataError("Released runtime fleet fair reservation requires finishedAt and reason.");
    }
    if (record.fairAdmissionStatus !== undefined || record.dispatchOutcome !== undefined) {
      throw new MetadataError("Released runtime fleet fair reservation cannot contain M40 terminal evidence.");
    }
  }
}
