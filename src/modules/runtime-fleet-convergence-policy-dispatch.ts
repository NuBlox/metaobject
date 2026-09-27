import { ConcurrencyError, MetadataError } from "../errors/errors.js";
import type {
  RuntimeFleetConvergenceDispatchOutcome,
  RuntimeFleetConvergenceDispatchRun,
  RuntimeFleetConvergenceDispatcher,
} from "./runtime-fleet-convergence-dispatch.js";
import { validateRuntimeFleetConvergenceDispatchRun } from "./runtime-fleet-convergence-dispatch.js";
import type {
  RuntimeFleetConvergenceQueueEvaluation,
  RuntimeFleetConvergenceQueueEvaluationStore,
} from "./runtime-fleet-convergence-queue-policy.js";
import { validateRuntimeFleetConvergenceQueueEvaluation } from "./runtime-fleet-convergence-queue-policy.js";
import type {
  RuntimeFleetConvergenceCatalog,
  RuntimeFleetConvergenceWorkItem,
} from "./runtime-fleet-convergence.js";

export type RuntimeFleetPolicyDispatchStatus = "admitted" | "completed" | "failed";

export interface RuntimeFleetPolicyDispatchWork {
  readonly workId: string;
  readonly runtimeId: string;
  readonly action: RuntimeFleetConvergenceWorkItem["action"];
  readonly evaluatedRevision: number;
}

export interface RuntimeFleetPolicyDispatchRecord {
  readonly format: "nublox-metaobject-runtime-fleet-policy-dispatch";
  readonly formatVersion: 1;
  readonly admissionId: string;
  readonly revision: number;
  readonly status: RuntimeFleetPolicyDispatchStatus;
  readonly evaluationId: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly dispatchId: string;
  readonly workerId: string;
  readonly work: readonly RuntimeFleetPolicyDispatchWork[];
  readonly dispatchOutcome?: RuntimeFleetConvergenceDispatchOutcome;
  readonly error?: string;
  readonly admittedAt: string;
  readonly finishedAt?: string;
}

export interface RuntimeFleetPolicyDispatchFilter {
  readonly policyId?: string;
  readonly status?: RuntimeFleetPolicyDispatchStatus;
}

export interface RuntimeFleetPolicyDispatchStore {
  get(admissionId: string): Promise<RuntimeFleetPolicyDispatchRecord | null>;
  list(filter?: RuntimeFleetPolicyDispatchFilter): Promise<readonly RuntimeFleetPolicyDispatchRecord[]>;
  create(record: RuntimeFleetPolicyDispatchRecord): Promise<RuntimeFleetPolicyDispatchRecord>;
  save(record: RuntimeFleetPolicyDispatchRecord, expectedRevision: number): Promise<RuntimeFleetPolicyDispatchRecord>;
}

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryRuntimeFleetPolicyDispatchStore implements RuntimeFleetPolicyDispatchStore {
  readonly #records = new Map<string, RuntimeFleetPolicyDispatchRecord>();

  async get(admissionId: string): Promise<RuntimeFleetPolicyDispatchRecord | null> {
    const record = this.#records.get(admissionId);
    return record ? clone(record) : null;
  }

  async list(filter: RuntimeFleetPolicyDispatchFilter = {}): Promise<readonly RuntimeFleetPolicyDispatchRecord[]> {
    return [...this.#records.values()]
      .filter((record) => filter.policyId === undefined || record.policyId === filter.policyId)
      .filter((record) => filter.status === undefined || record.status === filter.status)
      .sort((left, right) => left.admittedAt.localeCompare(right.admittedAt) || left.admissionId.localeCompare(right.admissionId))
      .map(clone);
  }

  async create(record: RuntimeFleetPolicyDispatchRecord): Promise<RuntimeFleetPolicyDispatchRecord> {
    validateRuntimeFleetPolicyDispatchRecord(record);
    if (this.#records.has(record.admissionId)) {
      throw new ConcurrencyError(`Runtime fleet policy dispatch '${record.admissionId}' already exists.`);
    }
    const stored = clone({ ...record, revision: 1 });
    this.#records.set(stored.admissionId, stored);
    return clone(stored);
  }

  async save(record: RuntimeFleetPolicyDispatchRecord, expectedRevision: number): Promise<RuntimeFleetPolicyDispatchRecord> {
    validateRuntimeFleetPolicyDispatchRecord(record);
    const current = this.#records.get(record.admissionId);
    if (!current) throw new MetadataError(`Unknown runtime fleet policy dispatch '${record.admissionId}'.`);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new MetadataError("Runtime fleet policy dispatch expectedRevision must be a positive integer.");
    }
    if (current.revision !== expectedRevision) {
      throw new ConcurrencyError(
        `Runtime fleet policy dispatch conflict for '${record.admissionId}': expected revision ${expectedRevision}, found ${current.revision}.`,
      );
    }
    for (const [label, before, after] of [
      ["evaluationId", current.evaluationId, record.evaluationId],
      ["policyId", current.policyId, record.policyId],
      ["policyVersion", current.policyVersion, record.policyVersion],
      ["dispatchId", current.dispatchId, record.dispatchId],
      ["workerId", current.workerId, record.workerId],
      ["admittedAt", current.admittedAt, record.admittedAt],
    ] as const) {
      if (before !== after) throw new MetadataError(`Runtime fleet policy dispatch '${record.admissionId}' ${label} is immutable.`);
    }
    if (JSON.stringify(current.work) !== JSON.stringify(record.work)) {
      throw new MetadataError(`Runtime fleet policy dispatch '${record.admissionId}' work selection is immutable.`);
    }
    if (current.status !== "admitted") {
      throw new MetadataError(`Terminal runtime fleet policy dispatch '${record.admissionId}' is immutable.`);
    }
    const stored = clone({ ...record, revision: current.revision + 1 });
    this.#records.set(stored.admissionId, stored);
    return clone(stored);
  }
}

export interface RuntimeFleetConvergenceQueueEvaluationSource {
  get(evaluationId: string): Promise<RuntimeFleetConvergenceQueueEvaluation | null>;
}

export interface RuntimeFleetPolicyDispatchRequest {
  readonly admissionId: string;
  readonly evaluationId: string;
  readonly dispatchId: string;
  readonly workerId: string;
  /** Maximum eligible work admitted from the evaluation. Defaults to 100. */
  readonly maxItems?: number;
}

export interface RuntimeFleetPolicyDispatchResult {
  readonly admission: RuntimeFleetPolicyDispatchRecord;
  readonly dispatch?: RuntimeFleetConvergenceDispatchRun;
}

export type RuntimeFleetPolicyDispatchClock = () => Date;

/**
 * Bind an exact M37 eligibility snapshot to an M36 dispatch. Every selected M34
 * work revision is revalidated before an admission is persisted. Once admitted,
 * the same dispatch ID and work selection are used for crash-safe resume.
 */
export class RuntimeFleetPolicyDispatcher {
  constructor(
    private readonly evaluations: RuntimeFleetConvergenceQueueEvaluationSource,
    private readonly convergence: RuntimeFleetConvergenceCatalog,
    private readonly dispatcher: RuntimeFleetConvergenceDispatcher,
    private readonly admissions: RuntimeFleetPolicyDispatchStore,
    private readonly clock: RuntimeFleetPolicyDispatchClock = () => new Date(),
  ) {}

  async dispatch(request: RuntimeFleetPolicyDispatchRequest): Promise<RuntimeFleetPolicyDispatchResult> {
    assertText(request.admissionId, "admissionId");
    assertText(request.evaluationId, "evaluationId");
    assertText(request.dispatchId, "dispatchId");
    assertText(request.workerId, "workerId");
    if (await this.admissions.get(request.admissionId)) {
      throw new ConcurrencyError(`Runtime fleet policy dispatch '${request.admissionId}' already exists.`);
    }
    if (await this.dispatcher.get(request.dispatchId)) {
      throw new ConcurrencyError(`Runtime fleet convergence dispatch '${request.dispatchId}' already exists.`);
    }
    const maxItems = request.maxItems ?? 100;
    if (!Number.isSafeInteger(maxItems) || maxItems < 1) {
      throw new MetadataError("Runtime fleet policy dispatch maxItems must be a positive integer.");
    }

    const evaluation = await this.requireEvaluation(request.evaluationId);
    const selected = evaluation.eligibleWorkIds.slice(0, maxItems);
    const work = await this.revalidateSelection(evaluation, selected);
    const admitted = await this.admissions.create({
      format: "nublox-metaobject-runtime-fleet-policy-dispatch",
      formatVersion: 1,
      admissionId: request.admissionId,
      revision: 0,
      status: "admitted",
      evaluationId: evaluation.evaluationId,
      policyId: evaluation.policyId,
      policyVersion: evaluation.policyVersion,
      dispatchId: request.dispatchId,
      workerId: request.workerId,
      work,
      admittedAt: this.clock().toISOString(),
    });
    return this.execute(admitted);
  }

  async resume(admissionId: string): Promise<RuntimeFleetPolicyDispatchResult> {
    assertText(admissionId, "admissionId");
    const admission = await this.admissions.get(admissionId);
    if (!admission) throw new MetadataError(`Unknown runtime fleet policy dispatch '${admissionId}'.`);
    if (admission.status !== "admitted") {
      const dispatch = admission.status === "completed" ? await this.dispatcher.get(admission.dispatchId) : null;
      return { admission, ...(dispatch === null ? {} : { dispatch }) };
    }
    return this.execute(admission);
  }

  async get(admissionId: string): Promise<RuntimeFleetPolicyDispatchRecord | null> {
    assertText(admissionId, "admissionId");
    return this.admissions.get(admissionId);
  }

  async history(filter: RuntimeFleetPolicyDispatchFilter = {}): Promise<readonly RuntimeFleetPolicyDispatchRecord[]> {
    return this.admissions.list(filter);
  }

  private async execute(admission: RuntimeFleetPolicyDispatchRecord): Promise<RuntimeFleetPolicyDispatchResult> {
    try {
      let dispatch = await this.dispatcher.get(admission.dispatchId);
      if (!dispatch) {
        dispatch = await this.dispatcher.dispatch({
          dispatchId: admission.dispatchId,
          workerId: admission.workerId,
          workIds: admission.work.map((item) => item.workId),
          maxItems: Math.max(admission.work.length, 1),
        });
      }
      validateRuntimeFleetConvergenceDispatchRun(dispatch);
      const completed = await this.admissions.save({
        ...admission,
        status: "completed",
        dispatchOutcome: dispatch.outcome,
        finishedAt: this.clock().toISOString(),
      }, admission.revision);
      return { admission: completed, dispatch };
    } catch (error) {
      const failed = await this.admissions.save({
        ...admission,
        status: "failed",
        error: errorMessage(error),
        finishedAt: this.clock().toISOString(),
      }, admission.revision);
      return { admission: failed };
    }
  }

  private async requireEvaluation(evaluationId: string): Promise<RuntimeFleetConvergenceQueueEvaluation> {
    const evaluation = await this.evaluations.get(evaluationId);
    if (!evaluation) throw new MetadataError(`Unknown runtime fleet convergence queue evaluation '${evaluationId}'.`);
    validateRuntimeFleetConvergenceQueueEvaluation(evaluation);
    return evaluation;
  }

  private async revalidateSelection(
    evaluation: RuntimeFleetConvergenceQueueEvaluation,
    selected: readonly string[],
  ): Promise<readonly RuntimeFleetPolicyDispatchWork[]> {
    const decisions = new Map(evaluation.decisions.map((decision) => [decision.workId, decision] as const));
    const result: RuntimeFleetPolicyDispatchWork[] = [];
    for (const workId of selected) {
      const decision = decisions.get(workId);
      if (!decision || decision.status !== "eligible") {
        throw new MetadataError(`Runtime fleet policy dispatch selection '${workId}' is not eligible in evaluation '${evaluation.evaluationId}'.`);
      }
      const current = await this.convergence.get(workId);
      if (!current) throw new ConcurrencyError(`Runtime fleet policy dispatch work '${workId}' no longer exists.`);
      if (current.status !== "pending") {
        throw new ConcurrencyError(`Runtime fleet policy dispatch work '${workId}' is now '${current.status}', not pending.`);
      }
      if (current.revision !== decision.workRevision) {
        throw new ConcurrencyError(
          `Runtime fleet policy dispatch work '${workId}' is stale: evaluated revision ${decision.workRevision}, current revision ${current.revision}.`,
        );
      }
      if (current.runtimeId !== decision.runtimeId || current.action !== decision.action) {
        throw new MetadataError(`Runtime fleet policy dispatch work '${workId}' no longer matches its M37 decision identity.`);
      }
      result.push({
        workId: current.workId,
        runtimeId: current.runtimeId,
        action: current.action,
        evaluatedRevision: decision.workRevision,
      });
    }
    return result;
  }
}

function assertText(value: string, label: string): void {
  if (!value.trim()) throw new MetadataError(`Runtime fleet policy dispatch ${label} is required.`);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "Runtime fleet policy dispatch failed with an unknown error.";
}

const validStatuses = new Set<RuntimeFleetPolicyDispatchStatus>(["admitted", "completed", "failed"]);

export function validateRuntimeFleetPolicyDispatchRecord(record: RuntimeFleetPolicyDispatchRecord): void {
  if (record.format !== "nublox-metaobject-runtime-fleet-policy-dispatch" || record.formatVersion !== 1) {
    throw new MetadataError("Unsupported runtime fleet policy dispatch format.");
  }
  for (const [label, value] of Object.entries({
    admissionId: record.admissionId,
    evaluationId: record.evaluationId,
    policyId: record.policyId,
    dispatchId: record.dispatchId,
    workerId: record.workerId,
    admittedAt: record.admittedAt,
  })) assertText(value, label);
  if (!Number.isSafeInteger(record.revision) || record.revision < 0) {
    throw new MetadataError("Runtime fleet policy dispatch revision must be a non-negative integer.");
  }
  if (!Number.isSafeInteger(record.policyVersion) || record.policyVersion < 1) {
    throw new MetadataError("Runtime fleet policy dispatch policyVersion must be a positive integer.");
  }
  if (!validStatuses.has(record.status)) {
    throw new MetadataError(`Invalid runtime fleet policy dispatch status '${String(record.status)}'.`);
  }
  const ids = new Set<string>();
  for (const work of record.work) {
    assertText(work.workId, "workId");
    assertText(work.runtimeId, "runtimeId");
    if (!Number.isSafeInteger(work.evaluatedRevision) || work.evaluatedRevision < 1) {
      throw new MetadataError("Runtime fleet policy dispatch evaluatedRevision must be a positive integer.");
    }
    if (ids.has(work.workId)) throw new MetadataError(`Runtime fleet policy dispatch contains duplicate work '${work.workId}'.`);
    ids.add(work.workId);
  }
  if (record.status === "admitted") {
    if (record.dispatchOutcome !== undefined || record.error !== undefined || record.finishedAt !== undefined) {
      throw new MetadataError("Admitted runtime fleet policy dispatch cannot contain terminal state.");
    }
  } else if (record.status === "completed") {
    if (record.dispatchOutcome === undefined || !record.finishedAt?.trim() || record.error !== undefined) {
      throw new MetadataError("Completed runtime fleet policy dispatch requires dispatch outcome and finishedAt without error.");
    }
  } else if (record.status === "failed") {
    if (!record.error?.trim() || !record.finishedAt?.trim() || record.dispatchOutcome !== undefined) {
      throw new MetadataError("Failed runtime fleet policy dispatch requires error and finishedAt without dispatch outcome.");
    }
  }
}
