import { ConcurrencyError, MetadataError } from "../errors/errors.js";
import type {
  RuntimeFleetConvergenceAction,
  RuntimeFleetConvergenceCatalog,
  RuntimeFleetConvergenceWorkItem,
} from "./runtime-fleet-convergence.js";
import type {
  RuntimeTargetDesiredProfile,
  RuntimeTargetRecord,
  RuntimeTargetStore,
} from "./runtime-registry.js";

export type RuntimeFleetConvergenceExecutorIdempotencyMode = "keyed" | "reconciled";

export interface RuntimeFleetConvergenceExecutorEvidence {
  readonly externalReference?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type RuntimeFleetConvergenceExecutorResult =
  | {
      readonly status: "completed";
      readonly targetRevision: number;
      readonly summary: string;
      readonly evidence?: RuntimeFleetConvergenceExecutorEvidence;
    }
  | {
      readonly status: "failed";
      readonly targetRevision: number;
      readonly error: string;
      readonly evidence?: RuntimeFleetConvergenceExecutorEvidence;
    };

export type RuntimeFleetConvergenceReconciliationResult =
  | {
      readonly resolution: "completed";
      readonly targetRevision: number;
      readonly summary: string;
      readonly evidence?: RuntimeFleetConvergenceExecutorEvidence;
    }
  | { readonly resolution: "retry" }
  | { readonly resolution: "unknown"; readonly reason?: string };

export interface RuntimeFleetConvergenceExecutionContext {
  readonly work: RuntimeFleetConvergenceWorkItem;
  readonly target: RuntimeTargetRecord;
  readonly attempt: number;
  /** Stable across retries/recovery for one M34 work item. */
  readonly idempotencyKey: string;
}

export interface RuntimeFleetConvergenceExecutor {
  readonly id: string;
  readonly actions: readonly RuntimeFleetConvergenceAction[];
  readonly idempotency: RuntimeFleetConvergenceExecutorIdempotencyMode;
  execute(
    context: RuntimeFleetConvergenceExecutionContext,
  ): Promise<RuntimeFleetConvergenceExecutorResult> | RuntimeFleetConvergenceExecutorResult;
  reconcile?(
    context: RuntimeFleetConvergenceExecutionContext,
  ): Promise<RuntimeFleetConvergenceReconciliationResult> | RuntimeFleetConvergenceReconciliationResult;
}

export class RuntimeFleetConvergenceExecutorRegistry {
  readonly #byId = new Map<string, RuntimeFleetConvergenceExecutor>();
  readonly #byAction = new Map<RuntimeFleetConvergenceAction, RuntimeFleetConvergenceExecutor>();

  register(executor: RuntimeFleetConvergenceExecutor): this {
    if (!executor.id.trim()) throw new MetadataError("Runtime fleet convergence executor id is required.");
    if (executor.actions.length === 0) {
      throw new MetadataError(`Runtime fleet convergence executor '${executor.id}' must declare at least one action.`);
    }
    if (this.#byId.has(executor.id)) {
      throw new MetadataError(`Runtime fleet convergence executor '${executor.id}' is already registered.`);
    }
    if (executor.idempotency === "reconciled" && !executor.reconcile) {
      throw new MetadataError(`Reconciled runtime fleet convergence executor '${executor.id}' must implement reconcile().`);
    }

    const unique = new Set<RuntimeFleetConvergenceAction>();
    for (const action of executor.actions) {
      if (unique.has(action)) {
        throw new MetadataError(`Runtime fleet convergence executor '${executor.id}' declares duplicate action '${action}'.`);
      }
      unique.add(action);
      const existing = this.#byAction.get(action);
      if (existing) {
        throw new MetadataError(
          `Runtime fleet convergence action '${action}' is already handled by executor '${existing.id}'.`,
        );
      }
    }

    this.#byId.set(executor.id, executor);
    for (const action of unique) this.#byAction.set(action, executor);
    return this;
  }

  get(action: RuntimeFleetConvergenceAction): RuntimeFleetConvergenceExecutor | null {
    return this.#byAction.get(action) ?? null;
  }

  getById(id: string): RuntimeFleetConvergenceExecutor | null {
    return this.#byId.get(id) ?? null;
  }
}

export type RuntimeFleetConvergenceExecutionStatus = "running" | "completed" | "failed";

export interface RuntimeFleetConvergenceExecutionRecord {
  readonly format: "nublox-metaobject-runtime-fleet-convergence-execution";
  readonly formatVersion: 1;
  readonly executionId: string;
  readonly revision: number;
  readonly workId: string;
  readonly runtimeId: string;
  readonly action: RuntimeFleetConvergenceAction;
  readonly attempt: number;
  readonly executorId: string;
  readonly idempotencyKey: string;
  readonly desiredProfile: RuntimeTargetDesiredProfile;
  readonly targetRevisionBefore: number;
  readonly status: RuntimeFleetConvergenceExecutionStatus;
  readonly targetRevisionAfter?: number;
  readonly summary?: string;
  readonly error?: string;
  readonly uncertain?: boolean;
  readonly evidence?: RuntimeFleetConvergenceExecutorEvidence;
  readonly startedAt: string;
  readonly finishedAt?: string;
}

export interface RuntimeFleetConvergenceExecutionStore {
  get(executionId: string): Promise<RuntimeFleetConvergenceExecutionRecord | null>;
  list(workId: string): Promise<readonly RuntimeFleetConvergenceExecutionRecord[]>;
  create(record: RuntimeFleetConvergenceExecutionRecord): Promise<RuntimeFleetConvergenceExecutionRecord>;
  save(
    record: RuntimeFleetConvergenceExecutionRecord,
    expectedRevision: number,
  ): Promise<RuntimeFleetConvergenceExecutionRecord>;
}

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryRuntimeFleetConvergenceExecutionStore implements RuntimeFleetConvergenceExecutionStore {
  readonly #records = new Map<string, RuntimeFleetConvergenceExecutionRecord>();

  async get(executionId: string): Promise<RuntimeFleetConvergenceExecutionRecord | null> {
    const record = this.#records.get(executionId);
    return record ? clone(record) : null;
  }

  async list(workId: string): Promise<readonly RuntimeFleetConvergenceExecutionRecord[]> {
    return [...this.#records.values()]
      .filter((record) => record.workId === workId)
      .sort((left, right) => left.attempt - right.attempt || left.executionId.localeCompare(right.executionId))
      .map(clone);
  }

  async create(record: RuntimeFleetConvergenceExecutionRecord): Promise<RuntimeFleetConvergenceExecutionRecord> {
    validateRuntimeFleetConvergenceExecutionRecord(record);
    if (this.#records.has(record.executionId)) {
      throw new ConcurrencyError(`Runtime fleet convergence execution '${record.executionId}' already exists.`);
    }
    const stored = clone({ ...record, revision: 1 });
    this.#records.set(stored.executionId, stored);
    return clone(stored);
  }

  async save(
    record: RuntimeFleetConvergenceExecutionRecord,
    expectedRevision: number,
  ): Promise<RuntimeFleetConvergenceExecutionRecord> {
    validateRuntimeFleetConvergenceExecutionRecord(record);
    const current = this.#records.get(record.executionId);
    if (!current) throw new MetadataError(`Unknown runtime fleet convergence execution '${record.executionId}'.`);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new MetadataError("Runtime fleet convergence execution expectedRevision must be a positive integer.");
    }
    if (current.revision !== expectedRevision) {
      throw new ConcurrencyError(
        `Runtime fleet convergence execution conflict for '${record.executionId}': expected revision ${expectedRevision}, found ${current.revision}.`,
      );
    }
    for (const [label, before, after] of [
      ["workId", current.workId, record.workId],
      ["runtimeId", current.runtimeId, record.runtimeId],
      ["action", current.action, record.action],
      ["attempt", current.attempt, record.attempt],
      ["executorId", current.executorId, record.executorId],
      ["idempotencyKey", current.idempotencyKey, record.idempotencyKey],
      ["targetRevisionBefore", current.targetRevisionBefore, record.targetRevisionBefore],
      ["startedAt", current.startedAt, record.startedAt],
    ] as const) {
      if (before !== after) {
        throw new MetadataError(`Runtime fleet convergence execution '${record.executionId}' ${label} is immutable.`);
      }
    }
    if (
      current.desiredProfile.profileId !== record.desiredProfile.profileId
      || current.desiredProfile.profileVersion !== record.desiredProfile.profileVersion
    ) {
      throw new MetadataError(`Runtime fleet convergence execution '${record.executionId}' desiredProfile is immutable.`);
    }
    if (current.status !== "running") {
      throw new MetadataError(`Terminal runtime fleet convergence execution '${record.executionId}' is immutable.`);
    }

    const stored = clone({ ...record, revision: current.revision + 1 });
    this.#records.set(stored.executionId, stored);
    return clone(stored);
  }
}

export type RuntimeFleetConvergenceRunBlockedReason =
  | "missing-executor"
  | "work-failed"
  | "recovery-required"
  | "executor-mismatch"
  | "reconciliation-unknown"
  | "stale-target";

export interface RuntimeFleetConvergenceRunResult {
  readonly work: RuntimeFleetConvergenceWorkItem;
  readonly execution?: RuntimeFleetConvergenceExecutionRecord;
  readonly blockedReason?: RuntimeFleetConvergenceRunBlockedReason;
}

export type RuntimeFleetConvergenceExecutionClock = () => Date;
export type RuntimeFleetConvergenceExecutionIdFactory = (workId: string, attempt: number) => string;
export type RuntimeFleetConvergenceIdempotencyKeyFactory = (
  work: RuntimeFleetConvergenceWorkItem,
) => string;

function defaultExecutionId(workId: string, attempt: number): string {
  return `${workId}:attempt:${attempt}`;
}

function defaultIdempotencyKey(work: RuntimeFleetConvergenceWorkItem): string {
  return `${work.workId}:${work.action}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "Runtime fleet convergence executor failed with an unknown error.";
}

/**
 * Execute M34 coordination records through pluggable action executors. Executors
 * may call the already-governed M16/M24/M29 APIs, but this runner never bypasses
 * those APIs or mutates M31 desired state itself.
 */
export class RuntimeFleetConvergenceRunner {
  constructor(
    private readonly convergence: RuntimeFleetConvergenceCatalog,
    private readonly targets: RuntimeTargetStore,
    private readonly executions: RuntimeFleetConvergenceExecutionStore,
    private readonly executors: RuntimeFleetConvergenceExecutorRegistry,
    private readonly clock: RuntimeFleetConvergenceExecutionClock = () => new Date(),
    private readonly executionIds: RuntimeFleetConvergenceExecutionIdFactory = defaultExecutionId,
    private readonly idempotencyKeys: RuntimeFleetConvergenceIdempotencyKeyFactory = defaultIdempotencyKey,
  ) {}

  async run(workId: string, workerId: string): Promise<RuntimeFleetConvergenceRunResult> {
    const current = await this.requireWork(workId);
    if (current.status === "completed" || current.status === "cancelled") return { work: current };
    if (current.status === "failed") return { work: current, blockedReason: "work-failed" };
    if (current.status === "in-progress") return { work: current, blockedReason: "recovery-required" };

    const executor = this.executors.get(current.action);
    if (!executor) return { work: current, blockedReason: "missing-executor" };

    let claimed: RuntimeFleetConvergenceWorkItem;
    try {
      claimed = await this.convergence.claim(current.workId, workerId, current.revision);
    } catch (error) {
      if (error instanceof ConcurrencyError || /stale|retired|no longer exists/i.test(errorMessage(error))) {
        return { work: await this.requireWork(workId), blockedReason: "stale-target" };
      }
      throw error;
    }

    const target = await this.requireTarget(claimed.runtimeId);
    if (target.revision !== claimed.targetRevision) {
      const failed = await this.convergence.fail(
        claimed.workId,
        `Runtime target changed immediately after work claim: expected revision ${claimed.targetRevision}, found ${target.revision}.`,
        claimed.revision,
      );
      return { work: failed, blockedReason: "stale-target" };
    }

    const history = await this.executions.list(claimed.workId);
    const attempt = history.length + 1;
    const idempotencyKey = this.idempotencyKeys(claimed);
    if (!idempotencyKey.trim()) throw new MetadataError("Runtime fleet convergence idempotency key cannot be empty.");
    const executionId = this.executionIds(claimed.workId, attempt);
    if (!executionId.trim()) throw new MetadataError("Runtime fleet convergence execution id cannot be empty.");

    let execution: RuntimeFleetConvergenceExecutionRecord;
    try {
      execution = await this.executions.create({
        format: "nublox-metaobject-runtime-fleet-convergence-execution",
        formatVersion: 1,
        executionId,
        revision: 0,
        workId: claimed.workId,
        runtimeId: claimed.runtimeId,
        action: claimed.action,
        attempt,
        executorId: executor.id,
        idempotencyKey,
        desiredProfile: clone(target.desiredProfile),
        targetRevisionBefore: target.revision,
        status: "running",
        startedAt: this.clock().toISOString(),
      });
    } catch (error) {
      await this.convergence.fail(claimed.workId, `Execution record creation failed: ${errorMessage(error)}`, claimed.revision);
      throw error;
    }

    return this.execute(executor, claimed, target, execution);
  }

  async resume(workId: string): Promise<RuntimeFleetConvergenceRunResult> {
    const work = await this.requireWork(workId);
    if (work.status === "completed" || work.status === "cancelled") return { work };
    if (work.status === "failed") return { work, blockedReason: "work-failed" };
    if (work.status === "pending") return { work, blockedReason: "recovery-required" };

    const history = await this.executions.list(work.workId);
    const execution = history.at(-1);
    if (!execution) return { work, blockedReason: "recovery-required" };
    const executor = this.executors.getById(execution.executorId);
    const actionExecutor = this.executors.get(work.action);
    if (!executor || !actionExecutor || executor.id !== actionExecutor.id) {
      return { work, execution, blockedReason: "executor-mismatch" };
    }

    let target: RuntimeTargetRecord;
    try {
      target = await this.requireTarget(work.runtimeId);
    } catch (error) {
      await this.failWorkOnly(work, errorMessage(error));
      return { work: await this.requireWork(work.workId), execution, blockedReason: "stale-target" };
    }
    if (!sameProfile(target.desiredProfile, execution.desiredProfile)) {
      return this.failClosed(work, execution, "Runtime desired profile changed during convergence execution.");
    }

    if (execution.status === "completed") {
      if (execution.targetRevisionAfter !== target.revision) {
        await this.failWorkOnly(work, "Runtime target changed after executor completion but before work finalization.");
        return { work: await this.requireWork(work.workId), execution, blockedReason: "stale-target" };
      }
      const completed = await this.convergence.complete(work.workId, execution.summary!, work.revision);
      return { work: completed, execution };
    }
    if (execution.status === "failed") {
      await this.failWorkOnly(work, execution.error ?? "Convergence execution failed.");
      return { work: await this.requireWork(work.workId), execution, blockedReason: "work-failed" };
    }

    const context = this.context(work, target, execution);
    if (executor.idempotency === "reconciled") {
      const reconciliation = await executor.reconcile!(context);
      if (reconciliation.resolution === "unknown") {
        return { work, execution, blockedReason: "reconciliation-unknown" };
      }
      if (reconciliation.resolution === "completed") {
        return this.settleCompleted(
          work,
          execution,
          reconciliation.targetRevision,
          reconciliation.summary,
          reconciliation.evidence,
        );
      }
    }

    return this.execute(executor, work, target, execution);
  }

  async retry(workId: string, workerId: string): Promise<RuntimeFleetConvergenceRunResult> {
    const current = await this.requireWork(workId);
    if (current.status !== "failed") {
      throw new MetadataError(`Runtime fleet convergence work '${workId}' is '${current.status}' and cannot be retried by the runner.`);
    }
    const history = await this.executions.list(workId);
    const latest = history.at(-1);
    const executor = this.executors.get(current.action);
    if (!executor) return { work: current, ...(latest === undefined ? {} : { execution: latest }), blockedReason: "missing-executor" };
    if (latest?.uncertain && executor.idempotency === "reconciled") {
      return { work: current, execution: latest, blockedReason: "reconciliation-unknown" };
    }
    const pending = await this.convergence.retry(workId, current.revision);
    return this.run(pending.workId, workerId);
  }

  private async execute(
    executor: RuntimeFleetConvergenceExecutor,
    work: RuntimeFleetConvergenceWorkItem,
    target: RuntimeTargetRecord,
    execution: RuntimeFleetConvergenceExecutionRecord,
  ): Promise<RuntimeFleetConvergenceRunResult> {
    let result: RuntimeFleetConvergenceExecutorResult;
    try {
      result = await executor.execute(this.context(work, target, execution));
    } catch (error) {
      const message = errorMessage(error);
      const failedExecution = await this.executions.save({
        ...execution,
        status: "failed",
        error: message,
        uncertain: true,
        finishedAt: this.clock().toISOString(),
      }, execution.revision);
      const failedWork = await this.convergence.fail(work.workId, message, work.revision);
      return { work: failedWork, execution: failedExecution, blockedReason: "work-failed" };
    }

    if (result.status === "failed") {
      return this.settleFailed(work, execution, result.targetRevision, result.error, result.evidence, false);
    }
    return this.settleCompleted(work, execution, result.targetRevision, result.summary, result.evidence);
  }

  private async settleCompleted(
    work: RuntimeFleetConvergenceWorkItem,
    execution: RuntimeFleetConvergenceExecutionRecord,
    targetRevision: number,
    summary: string,
    evidence?: RuntimeFleetConvergenceExecutorEvidence,
  ): Promise<RuntimeFleetConvergenceRunResult> {
    assertPositiveRevision(targetRevision, "targetRevision");
    assertText(summary, "summary");
    const target = await this.requireTarget(work.runtimeId);
    if (!sameProfile(target.desiredProfile, execution.desiredProfile) || target.revision !== targetRevision) {
      return this.failClosed(work, execution, "Runtime target changed before executor completion could be committed.");
    }
    const completedExecution = await this.executions.save({
      ...execution,
      status: "completed",
      targetRevisionAfter: targetRevision,
      summary,
      ...(evidence === undefined ? {} : { evidence: normalizeEvidence(evidence) }),
      finishedAt: this.clock().toISOString(),
    }, execution.revision);
    const completedWork = await this.convergence.complete(work.workId, summary, work.revision);
    return { work: completedWork, execution: completedExecution };
  }

  private async settleFailed(
    work: RuntimeFleetConvergenceWorkItem,
    execution: RuntimeFleetConvergenceExecutionRecord,
    targetRevision: number,
    error: string,
    evidence: RuntimeFleetConvergenceExecutorEvidence | undefined,
    uncertain: boolean,
  ): Promise<RuntimeFleetConvergenceRunResult> {
    assertPositiveRevision(targetRevision, "targetRevision");
    assertText(error, "error");
    const target = await this.requireTarget(work.runtimeId);
    if (!sameProfile(target.desiredProfile, execution.desiredProfile) || target.revision !== targetRevision) {
      return this.failClosed(work, execution, "Runtime target changed while executor failure was being recorded.");
    }
    const failedExecution = await this.executions.save({
      ...execution,
      status: "failed",
      targetRevisionAfter: targetRevision,
      error,
      uncertain,
      ...(evidence === undefined ? {} : { evidence: normalizeEvidence(evidence) }),
      finishedAt: this.clock().toISOString(),
    }, execution.revision);
    const failedWork = await this.convergence.fail(work.workId, error, work.revision);
    return { work: failedWork, execution: failedExecution, blockedReason: "work-failed" };
  }

  private async failClosed(
    work: RuntimeFleetConvergenceWorkItem,
    execution: RuntimeFleetConvergenceExecutionRecord,
    error: string,
  ): Promise<RuntimeFleetConvergenceRunResult> {
    const latestExecution = execution.status === "running"
      ? await this.executions.save({
          ...execution,
          status: "failed",
          error,
          uncertain: true,
          finishedAt: this.clock().toISOString(),
        }, execution.revision)
      : execution;
    const failedWork = work.status === "in-progress"
      ? await this.convergence.fail(work.workId, error, work.revision)
      : work;
    return { work: failedWork, execution: latestExecution, blockedReason: "stale-target" };
  }

  private async failWorkOnly(work: RuntimeFleetConvergenceWorkItem, error: string): Promise<void> {
    if (work.status === "in-progress") await this.convergence.fail(work.workId, error, work.revision);
  }

  private context(
    work: RuntimeFleetConvergenceWorkItem,
    target: RuntimeTargetRecord,
    execution: RuntimeFleetConvergenceExecutionRecord,
  ): RuntimeFleetConvergenceExecutionContext {
    return {
      work: clone(work),
      target: clone(target),
      attempt: execution.attempt,
      idempotencyKey: execution.idempotencyKey,
    };
  }

  private async requireWork(workId: string): Promise<RuntimeFleetConvergenceWorkItem> {
    assertText(workId, "workId");
    const work = await this.convergence.get(workId);
    if (!work) throw new MetadataError(`Unknown runtime fleet convergence work '${workId}'.`);
    return work;
  }

  private async requireTarget(runtimeId: string): Promise<RuntimeTargetRecord> {
    const target = await this.targets.get(runtimeId);
    if (!target) throw new MetadataError(`Unknown runtime target '${runtimeId}'.`);
    if (target.status !== "active") throw new MetadataError(`Runtime target '${runtimeId}' is retired.`);
    return target;
  }
}

function sameProfile(left: RuntimeTargetDesiredProfile, right: RuntimeTargetDesiredProfile): boolean {
  return left.profileId === right.profileId && left.profileVersion === right.profileVersion;
}

function normalizeEvidence(evidence: RuntimeFleetConvergenceExecutorEvidence): RuntimeFleetConvergenceExecutorEvidence {
  if (evidence.externalReference !== undefined && !evidence.externalReference.trim()) {
    throw new MetadataError("Runtime fleet convergence executor evidence externalReference cannot be empty.");
  }
  return {
    ...(evidence.externalReference === undefined ? {} : { externalReference: evidence.externalReference }),
    ...(evidence.details === undefined ? {} : { details: clone(evidence.details) }),
  };
}

function assertText(value: string, label: string): void {
  if (!value.trim()) throw new MetadataError(`Runtime fleet convergence execution ${label} is required.`);
}

function assertPositiveRevision(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new MetadataError(`Runtime fleet convergence execution ${label} must be a positive integer.`);
  }
}

const validStatuses = new Set<RuntimeFleetConvergenceExecutionStatus>(["running", "completed", "failed"]);

export function validateRuntimeFleetConvergenceExecutionRecord(record: RuntimeFleetConvergenceExecutionRecord): void {
  if (record.format !== "nublox-metaobject-runtime-fleet-convergence-execution" || record.formatVersion !== 1) {
    throw new MetadataError("Unsupported runtime fleet convergence execution format.");
  }
  for (const [label, value] of Object.entries({
    executionId: record.executionId,
    workId: record.workId,
    runtimeId: record.runtimeId,
    executorId: record.executorId,
    idempotencyKey: record.idempotencyKey,
    startedAt: record.startedAt,
  })) assertText(value, label);
  if (!Number.isSafeInteger(record.revision) || record.revision < 0) {
    throw new MetadataError("Runtime fleet convergence execution revision must be a non-negative integer.");
  }
  assertPositiveRevision(record.attempt, "attempt");
  assertPositiveRevision(record.targetRevisionBefore, "targetRevisionBefore");
  assertText(record.desiredProfile.profileId, "desired profileId");
  assertPositiveRevision(record.desiredProfile.profileVersion, "desired profileVersion");
  if (!validStatuses.has(record.status)) {
    throw new MetadataError(`Invalid runtime fleet convergence execution status '${String(record.status)}'.`);
  }
  if (record.status === "running") {
    if (
      record.targetRevisionAfter !== undefined
      || record.summary !== undefined
      || record.error !== undefined
      || record.uncertain !== undefined
      || record.evidence !== undefined
      || record.finishedAt !== undefined
    ) {
      throw new MetadataError("Running runtime fleet convergence execution cannot contain terminal state.");
    }
    return;
  }
  if (!record.finishedAt?.trim()) {
    throw new MetadataError(`Terminal runtime fleet convergence execution '${record.status}' requires finishedAt.`);
  }
  if (record.status === "completed") {
    assertPositiveRevision(record.targetRevisionAfter!, "targetRevisionAfter");
    if (!record.summary?.trim()) throw new MetadataError("Completed runtime fleet convergence execution requires summary.");
    if (record.error !== undefined || record.uncertain !== undefined) {
      throw new MetadataError("Completed runtime fleet convergence execution cannot contain failure state.");
    }
  } else {
    if (!record.error?.trim()) throw new MetadataError("Failed runtime fleet convergence execution requires error.");
    if (record.uncertain === undefined) throw new MetadataError("Failed runtime fleet convergence execution requires uncertain flag.");
    if (record.summary !== undefined) throw new MetadataError("Failed runtime fleet convergence execution cannot contain summary.");
    if (record.targetRevisionAfter !== undefined) {
      assertPositiveRevision(record.targetRevisionAfter, "targetRevisionAfter");
    } else if (!record.uncertain) {
      throw new MetadataError("Certain failed runtime fleet convergence execution requires targetRevisionAfter.");
    }
  }
  if (record.evidence !== undefined) normalizeEvidence(record.evidence);
}
