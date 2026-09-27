import { ConcurrencyError, MetadataError } from "../errors/errors.js";
import type {
  RuntimeFleetConvergenceDispatchOutcome,
  RuntimeFleetConvergenceDispatchRun,
  RuntimeFleetConvergenceDispatcher,
} from "./runtime-fleet-convergence-dispatch.js";
import { validateRuntimeFleetConvergenceDispatchRun } from "./runtime-fleet-convergence-dispatch.js";
import type {
  RuntimeFleetConvergenceFairnessDecision,
  RuntimeFleetConvergenceFairnessEvaluation,
} from "./runtime-fleet-convergence-fairness.js";
import { validateRuntimeFleetConvergenceFairnessEvaluation } from "./runtime-fleet-convergence-fairness.js";
import type {
  RuntimeFleetConvergenceCatalog,
  RuntimeFleetConvergenceWorkItem,
} from "./runtime-fleet-convergence.js";

export type RuntimeFleetFairDispatchStatus = "admitted" | "completed" | "failed" | "cancelled";

export interface RuntimeFleetFairDispatchWork {
  readonly workId: string;
  readonly runtimeId: string;
  readonly action: RuntimeFleetConvergenceWorkItem["action"];
  readonly evaluatedRevision: number;
  readonly fairnessRank: number;
  readonly effectivePriority: number;
  readonly starved: boolean;
}

export interface RuntimeFleetFairDispatchRecord {
  readonly format: "nublox-metaobject-runtime-fleet-fair-dispatch";
  readonly formatVersion: 1;
  readonly admissionId: string;
  readonly revision: number;
  readonly status: RuntimeFleetFairDispatchStatus;
  readonly fairnessId: string;
  readonly fairnessPolicyId: string;
  readonly fairnessPolicyVersion: number;
  readonly sourceEvaluationId: string;
  readonly sourcePolicyId: string;
  readonly sourcePolicyVersion: number;
  readonly dispatchId: string;
  readonly workerId: string;
  readonly work: readonly RuntimeFleetFairDispatchWork[];
  readonly dispatchOutcome?: RuntimeFleetConvergenceDispatchOutcome;
  readonly error?: string;
  readonly reason?: string;
  readonly admittedAt: string;
  readonly finishedAt?: string;
}

export interface RuntimeFleetFairDispatchFilter {
  readonly fairnessPolicyId?: string;
  readonly status?: RuntimeFleetFairDispatchStatus;
}

export interface RuntimeFleetFairDispatchStore {
  get(admissionId: string): Promise<RuntimeFleetFairDispatchRecord | null>;
  list(filter?: RuntimeFleetFairDispatchFilter): Promise<readonly RuntimeFleetFairDispatchRecord[]>;
  create(record: RuntimeFleetFairDispatchRecord): Promise<RuntimeFleetFairDispatchRecord>;
  save(record: RuntimeFleetFairDispatchRecord, expectedRevision: number): Promise<RuntimeFleetFairDispatchRecord>;
}

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryRuntimeFleetFairDispatchStore implements RuntimeFleetFairDispatchStore {
  readonly #records = new Map<string, RuntimeFleetFairDispatchRecord>();

  async get(admissionId: string): Promise<RuntimeFleetFairDispatchRecord | null> {
    const record = this.#records.get(admissionId);
    return record ? clone(record) : null;
  }

  async list(filter: RuntimeFleetFairDispatchFilter = {}): Promise<readonly RuntimeFleetFairDispatchRecord[]> {
    return [...this.#records.values()]
      .filter((record) => filter.fairnessPolicyId === undefined || record.fairnessPolicyId === filter.fairnessPolicyId)
      .filter((record) => filter.status === undefined || record.status === filter.status)
      .sort((left, right) => left.admittedAt.localeCompare(right.admittedAt) || left.admissionId.localeCompare(right.admissionId))
      .map(clone);
  }

  async create(record: RuntimeFleetFairDispatchRecord): Promise<RuntimeFleetFairDispatchRecord> {
    validateRuntimeFleetFairDispatchRecord(record);
    if (this.#records.has(record.admissionId)) {
      throw new ConcurrencyError(`Runtime fleet fair dispatch '${record.admissionId}' already exists.`);
    }
    const stored = clone({ ...record, revision: 1 });
    this.#records.set(stored.admissionId, stored);
    return clone(stored);
  }

  async save(record: RuntimeFleetFairDispatchRecord, expectedRevision: number): Promise<RuntimeFleetFairDispatchRecord> {
    validateRuntimeFleetFairDispatchRecord(record);
    const current = this.#records.get(record.admissionId);
    if (!current) throw new MetadataError(`Unknown runtime fleet fair dispatch '${record.admissionId}'.`);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new MetadataError("Runtime fleet fair dispatch expectedRevision must be a positive integer.");
    }
    if (current.revision !== expectedRevision) {
      throw new ConcurrencyError(
        `Runtime fleet fair dispatch conflict for '${record.admissionId}': expected revision ${expectedRevision}, found ${current.revision}.`,
      );
    }
    for (const [label, before, after] of [
      ["fairnessId", current.fairnessId, record.fairnessId],
      ["fairnessPolicyId", current.fairnessPolicyId, record.fairnessPolicyId],
      ["fairnessPolicyVersion", current.fairnessPolicyVersion, record.fairnessPolicyVersion],
      ["sourceEvaluationId", current.sourceEvaluationId, record.sourceEvaluationId],
      ["sourcePolicyId", current.sourcePolicyId, record.sourcePolicyId],
      ["sourcePolicyVersion", current.sourcePolicyVersion, record.sourcePolicyVersion],
      ["dispatchId", current.dispatchId, record.dispatchId],
      ["workerId", current.workerId, record.workerId],
      ["admittedAt", current.admittedAt, record.admittedAt],
    ] as const) {
      if (before !== after) throw new MetadataError(`Runtime fleet fair dispatch '${record.admissionId}' ${label} is immutable.`);
    }
    if (JSON.stringify(current.work) !== JSON.stringify(record.work)) {
      throw new MetadataError(`Runtime fleet fair dispatch '${record.admissionId}' work selection is immutable.`);
    }
    if (current.status !== "admitted") {
      throw new MetadataError(`Terminal runtime fleet fair dispatch '${record.admissionId}' is immutable.`);
    }
    const stored = clone({ ...record, revision: current.revision + 1 });
    this.#records.set(stored.admissionId, stored);
    return clone(stored);
  }
}

export interface RuntimeFleetConvergenceFairnessSource {
  get(fairnessId: string): Promise<RuntimeFleetConvergenceFairnessEvaluation | null>;
}

export interface RuntimeFleetFairDispatchRequest {
  readonly admissionId: string;
  readonly fairnessId: string;
  readonly dispatchId: string;
  readonly workerId: string;
  /** Maximum ranked work admitted from the fairness evaluation. Defaults to 100. */
  readonly maxItems?: number;
}

export interface RuntimeFleetFairDispatchCancellationRequest extends RuntimeFleetFairDispatchRequest {
  readonly reason: string;
}

export interface RuntimeFleetFairDispatchResult {
  readonly admission: RuntimeFleetFairDispatchRecord;
  readonly dispatch?: RuntimeFleetConvergenceDispatchRun;
}

export type RuntimeFleetFairDispatchClock = () => Date;

/**
 * Bind one exact M39 fairness ordering to one M36 dispatch. M40 preserves the
 * M37 safety set indirectly through immutable M39 provenance, revalidates every
 * M34 revision before admission, and persists the admission before dispatch.
 *
 * M43 also permits a terminal cancellation tombstone to compete atomically for
 * the same admission ID. If cancellation wins, later stale dispatch attempts
 * cannot create that admission or reach M36.
 */
export class RuntimeFleetFairDispatcher {
  constructor(
    private readonly fairness: RuntimeFleetConvergenceFairnessSource,
    private readonly convergence: RuntimeFleetConvergenceCatalog,
    private readonly dispatcher: RuntimeFleetConvergenceDispatcher,
    private readonly admissions: RuntimeFleetFairDispatchStore,
    private readonly clock: RuntimeFleetFairDispatchClock = () => new Date(),
  ) {}

  async dispatch(request: RuntimeFleetFairDispatchRequest): Promise<RuntimeFleetFairDispatchResult> {
    validateRequest(request);
    if (await this.admissions.get(request.admissionId)) {
      throw new ConcurrencyError(`Runtime fleet fair dispatch '${request.admissionId}' already exists.`);
    }
    if (await this.dispatcher.get(request.dispatchId)) {
      throw new ConcurrencyError(`Runtime fleet convergence dispatch '${request.dispatchId}' already exists.`);
    }
    const maxItems = maxItemsFor(request.maxItems);
    const evaluation = await this.requireFairness(request.fairnessId);
    const selectedIds = evaluation.orderedWorkIds.slice(0, maxItems);
    const selected = await this.revalidateSelection(evaluation, selectedIds);
    const admitted = await this.admissions.create({
      format: "nublox-metaobject-runtime-fleet-fair-dispatch",
      formatVersion: 1,
      admissionId: request.admissionId,
      revision: 0,
      status: "admitted",
      fairnessId: evaluation.fairnessId,
      fairnessPolicyId: evaluation.fairnessPolicyId,
      fairnessPolicyVersion: evaluation.fairnessPolicyVersion,
      sourceEvaluationId: evaluation.sourceEvaluationId,
      sourcePolicyId: evaluation.sourcePolicyId,
      sourcePolicyVersion: evaluation.sourcePolicyVersion,
      dispatchId: request.dispatchId,
      workerId: request.workerId,
      work: selected,
      admittedAt: this.clock().toISOString(),
    });
    return this.execute(admitted);
  }

  async cancel(request: RuntimeFleetFairDispatchCancellationRequest): Promise<RuntimeFleetFairDispatchRecord> {
    validateRequest(request);
    assertText(request.reason, "cancellation reason");
    const existing = await this.admissions.get(request.admissionId);
    if (existing) {
      if (existing.status === "cancelled") {
        assertCancellationMatches(existing, request);
        return existing;
      }
      throw new ConcurrencyError(
        `Runtime fleet fair dispatch '${request.admissionId}' is already '${existing.status}' and cannot be cancelled.`,
      );
    }
    if (await this.dispatcher.get(request.dispatchId)) {
      throw new ConcurrencyError(
        `Runtime fleet convergence dispatch '${request.dispatchId}' already exists; fair dispatch '${request.admissionId}' cannot be cancelled.`,
      );
    }
    const maxItems = maxItemsFor(request.maxItems);
    const evaluation = await this.requireFairness(request.fairnessId);
    const selectedIds = evaluation.orderedWorkIds.slice(0, maxItems);
    const selected = await this.revalidateSelection(evaluation, selectedIds);
    const now = this.clock().toISOString();
    return this.admissions.create({
      format: "nublox-metaobject-runtime-fleet-fair-dispatch",
      formatVersion: 1,
      admissionId: request.admissionId,
      revision: 0,
      status: "cancelled",
      fairnessId: evaluation.fairnessId,
      fairnessPolicyId: evaluation.fairnessPolicyId,
      fairnessPolicyVersion: evaluation.fairnessPolicyVersion,
      sourceEvaluationId: evaluation.sourceEvaluationId,
      sourcePolicyId: evaluation.sourcePolicyId,
      sourcePolicyVersion: evaluation.sourcePolicyVersion,
      dispatchId: request.dispatchId,
      workerId: request.workerId,
      work: selected,
      reason: request.reason,
      admittedAt: now,
      finishedAt: now,
    });
  }

  async resume(admissionId: string): Promise<RuntimeFleetFairDispatchResult> {
    assertText(admissionId, "admissionId");
    const admission = await this.admissions.get(admissionId);
    if (!admission) throw new MetadataError(`Unknown runtime fleet fair dispatch '${admissionId}'.`);
    if (admission.status !== "admitted") {
      const dispatch = admission.status === "completed" ? await this.dispatcher.get(admission.dispatchId) : null;
      return { admission, ...(dispatch === null ? {} : { dispatch }) };
    }
    return this.execute(admission);
  }

  async get(admissionId: string): Promise<RuntimeFleetFairDispatchRecord | null> {
    assertText(admissionId, "admissionId");
    return this.admissions.get(admissionId);
  }

  async history(filter: RuntimeFleetFairDispatchFilter = {}): Promise<readonly RuntimeFleetFairDispatchRecord[]> {
    return this.admissions.list(filter);
  }

  private async execute(admission: RuntimeFleetFairDispatchRecord): Promise<RuntimeFleetFairDispatchResult> {
    const existing = await this.dispatcher.get(admission.dispatchId);
    if (existing) {
      validateRuntimeFleetConvergenceDispatchRun(existing);
      const completed = await this.complete(admission, existing);
      return { admission: completed, dispatch: existing };
    }

    try {
      const dispatch = await this.dispatcher.dispatch({
        dispatchId: admission.dispatchId,
        workerId: admission.workerId,
        workIds: admission.work.map((item) => item.workId),
        maxItems: Math.max(1, admission.work.length),
      });
      const completed = await this.complete(admission, dispatch);
      return { admission: completed, dispatch };
    } catch (error) {
      const later = await this.dispatcher.get(admission.dispatchId);
      if (later) {
        validateRuntimeFleetConvergenceDispatchRun(later);
        const completed = await this.complete(admission, later);
        return { admission: completed, dispatch: later };
      }
      const failed = await this.admissions.save({
        ...admission,
        status: "failed",
        error: errorMessage(error),
        finishedAt: this.clock().toISOString(),
      }, admission.revision);
      return { admission: failed };
    }
  }

  private async complete(
    admission: RuntimeFleetFairDispatchRecord,
    dispatch: RuntimeFleetConvergenceDispatchRun,
  ): Promise<RuntimeFleetFairDispatchRecord> {
    if (dispatch.dispatchId !== admission.dispatchId || dispatch.workerId !== admission.workerId) {
      throw new MetadataError(`Runtime fleet fair dispatch '${admission.admissionId}' recovered mismatched M36 dispatch evidence.`);
    }
    const expectedIds = admission.work.map((item) => item.workId);
    const actualIds = dispatch.items.map((item) => item.workId);
    if (JSON.stringify(expectedIds) !== JSON.stringify(actualIds)) {
      throw new MetadataError(`Runtime fleet fair dispatch '${admission.admissionId}' M36 work order does not match admitted fairness order.`);
    }
    return this.admissions.save({
      ...admission,
      status: "completed",
      dispatchOutcome: dispatch.outcome,
      finishedAt: this.clock().toISOString(),
    }, admission.revision);
  }

  private async requireFairness(fairnessId: string): Promise<RuntimeFleetConvergenceFairnessEvaluation> {
    const evaluation = await this.fairness.get(fairnessId);
    if (!evaluation) throw new MetadataError(`Unknown runtime fleet convergence fairness evaluation '${fairnessId}'.`);
    validateRuntimeFleetConvergenceFairnessEvaluation(evaluation);
    return evaluation;
  }

  private async revalidateSelection(
    evaluation: RuntimeFleetConvergenceFairnessEvaluation,
    workIds: readonly string[],
  ): Promise<readonly RuntimeFleetFairDispatchWork[]> {
    const decisions = new Map(evaluation.decisions.map((decision) => [decision.workId, decision] as const));
    const selected: RuntimeFleetFairDispatchWork[] = [];
    for (const workId of workIds) {
      const decision = decisions.get(workId);
      if (!decision) throw new MetadataError(`Runtime fleet fair dispatch fairness decision '${workId}' is missing.`);
      const work = await this.convergence.get(workId);
      if (!work) throw new ConcurrencyError(`Runtime fleet convergence work '${workId}' no longer exists.`);
      assertExactWork(work, decision);
      selected.push({
        workId: work.workId,
        runtimeId: work.runtimeId,
        action: work.action,
        evaluatedRevision: decision.workRevision,
        fairnessRank: decision.rank,
        effectivePriority: decision.effectivePriority,
        starved: decision.starved,
      });
    }
    return selected;
  }
}

function validateRequest(request: RuntimeFleetFairDispatchRequest): void {
  assertText(request.admissionId, "admissionId");
  assertText(request.fairnessId, "fairnessId");
  assertText(request.dispatchId, "dispatchId");
  assertText(request.workerId, "workerId");
}

function maxItemsFor(value: number | undefined): number {
  const maxItems = value ?? 100;
  if (!Number.isSafeInteger(maxItems) || maxItems < 1) {
    throw new MetadataError("Runtime fleet fair dispatch maxItems must be a positive integer.");
  }
  return maxItems;
}

function assertCancellationMatches(
  record: RuntimeFleetFairDispatchRecord,
  request: RuntimeFleetFairDispatchCancellationRequest,
): void {
  if (
    record.fairnessId !== request.fairnessId
    || record.dispatchId !== request.dispatchId
    || record.workerId !== request.workerId
  ) {
    throw new ConcurrencyError(`Cancelled runtime fleet fair dispatch '${record.admissionId}' does not match the cancellation request.`);
  }
}

function assertExactWork(work: RuntimeFleetConvergenceWorkItem, decision: RuntimeFleetConvergenceFairnessDecision): void {
  if (work.status !== "pending") {
    throw new ConcurrencyError(`Runtime fleet convergence work '${work.workId}' is '${work.status}' and cannot be fairly admitted.`);
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
  if (!value.trim()) throw new MetadataError(`Runtime fleet fair dispatch ${label} is required.`);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new MetadataError(`Runtime fleet fair dispatch ${label} must be a positive integer.`);
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "Runtime fleet fair dispatch failed with an unknown error.";
}

const validStatuses = new Set<RuntimeFleetFairDispatchStatus>(["admitted", "completed", "failed", "cancelled"]);

export function validateRuntimeFleetFairDispatchRecord(record: RuntimeFleetFairDispatchRecord): void {
  if (record.format !== "nublox-metaobject-runtime-fleet-fair-dispatch" || record.formatVersion !== 1) {
    throw new MetadataError("Unsupported runtime fleet fair dispatch format.");
  }
  for (const [label, value] of Object.entries({
    admissionId: record.admissionId,
    fairnessId: record.fairnessId,
    fairnessPolicyId: record.fairnessPolicyId,
    sourceEvaluationId: record.sourceEvaluationId,
    sourcePolicyId: record.sourcePolicyId,
    dispatchId: record.dispatchId,
    workerId: record.workerId,
    admittedAt: record.admittedAt,
  })) assertText(value, label);
  if (!Number.isSafeInteger(record.revision) || record.revision < 0) {
    throw new MetadataError("Runtime fleet fair dispatch revision must be a non-negative integer.");
  }
  assertPositiveInteger(record.fairnessPolicyVersion, "fairnessPolicyVersion");
  assertPositiveInteger(record.sourcePolicyVersion, "sourcePolicyVersion");
  if (!validStatuses.has(record.status)) throw new MetadataError(`Invalid runtime fleet fair dispatch status '${String(record.status)}'.`);

  const ids = new Set<string>();
  let previousRank = 0;
  for (const item of record.work) {
    assertText(item.workId, "workId");
    assertText(item.runtimeId, "runtimeId");
    assertPositiveInteger(item.evaluatedRevision, "evaluatedRevision");
    assertPositiveInteger(item.fairnessRank, "fairnessRank");
    if (!Number.isFinite(item.effectivePriority)) {
      throw new MetadataError("Runtime fleet fair dispatch effectivePriority must be finite.");
    }
    if (item.fairnessRank <= previousRank) {
      throw new MetadataError("Runtime fleet fair dispatch work must preserve ascending M39 fairness rank.");
    }
    previousRank = item.fairnessRank;
    if (ids.has(item.workId)) throw new MetadataError(`Runtime fleet fair dispatch contains duplicate work '${item.workId}'.`);
    ids.add(item.workId);
  }

  if (record.status === "admitted") {
    if (
      record.dispatchOutcome !== undefined
      || record.error !== undefined
      || record.reason !== undefined
      || record.finishedAt !== undefined
    ) {
      throw new MetadataError("Admitted runtime fleet fair dispatch cannot contain terminal state.");
    }
  } else if (record.status === "completed") {
    if (
      record.dispatchOutcome === undefined
      || !record.finishedAt?.trim()
      || record.error !== undefined
      || record.reason !== undefined
    ) {
      throw new MetadataError("Completed runtime fleet fair dispatch requires dispatchOutcome and finishedAt only.");
    }
  } else if (record.status === "failed") {
    if (!record.error?.trim() || !record.finishedAt?.trim() || record.dispatchOutcome !== undefined || record.reason !== undefined) {
      throw new MetadataError("Failed runtime fleet fair dispatch requires error and finishedAt only.");
    }
  } else if (!record.reason?.trim() || !record.finishedAt?.trim() || record.dispatchOutcome !== undefined || record.error !== undefined) {
    throw new MetadataError("Cancelled runtime fleet fair dispatch requires reason and finishedAt only.");
  }
}