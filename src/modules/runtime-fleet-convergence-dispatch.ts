import { ConcurrencyError, MetadataError } from "../errors/errors.js";
import type {
  RuntimeFleetConvergenceAction,
  RuntimeFleetConvergenceCatalog,
  RuntimeFleetConvergenceWorkItem,
} from "./runtime-fleet-convergence.js";
import type {
  RuntimeFleetConvergenceRunBlockedReason,
  RuntimeFleetConvergenceRunner,
} from "./runtime-fleet-convergence-execution.js";

export type RuntimeFleetConvergenceDispatchItemStatus = "completed" | "blocked" | "failed";
export type RuntimeFleetConvergenceDispatchOutcome = "completed" | "partial" | "failed";

export interface RuntimeFleetConvergenceDispatchItem {
  readonly workId: string;
  readonly runtimeId: string;
  readonly action: RuntimeFleetConvergenceAction;
  readonly workRevisionBefore: number;
  readonly status: RuntimeFleetConvergenceDispatchItemStatus;
  readonly finalWorkStatus?: RuntimeFleetConvergenceWorkItem["status"];
  readonly executionId?: string;
  readonly blockedReason?: RuntimeFleetConvergenceRunBlockedReason;
  readonly error?: string;
}

export interface RuntimeFleetConvergenceDispatchRun {
  readonly format: "nublox-metaobject-runtime-fleet-convergence-dispatch";
  readonly formatVersion: 1;
  readonly dispatchId: string;
  readonly workerId: string;
  readonly outcome: RuntimeFleetConvergenceDispatchOutcome;
  readonly items: readonly RuntimeFleetConvergenceDispatchItem[];
  readonly total: number;
  readonly completed: number;
  readonly blocked: number;
  readonly failed: number;
  readonly startedAt: string;
  readonly completedAt: string;
}

export interface RuntimeFleetConvergenceDispatchFilter {
  readonly workerId?: string;
  readonly outcome?: RuntimeFleetConvergenceDispatchOutcome;
}

export interface RuntimeFleetConvergenceDispatchStore {
  get(dispatchId: string): Promise<RuntimeFleetConvergenceDispatchRun | null>;
  list(filter?: RuntimeFleetConvergenceDispatchFilter): Promise<readonly RuntimeFleetConvergenceDispatchRun[]>;
  create(run: RuntimeFleetConvergenceDispatchRun): Promise<RuntimeFleetConvergenceDispatchRun>;
}

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryRuntimeFleetConvergenceDispatchStore implements RuntimeFleetConvergenceDispatchStore {
  readonly #records = new Map<string, RuntimeFleetConvergenceDispatchRun>();

  async get(dispatchId: string): Promise<RuntimeFleetConvergenceDispatchRun | null> {
    const record = this.#records.get(dispatchId);
    return record ? clone(record) : null;
  }

  async list(filter: RuntimeFleetConvergenceDispatchFilter = {}): Promise<readonly RuntimeFleetConvergenceDispatchRun[]> {
    return [...this.#records.values()]
      .filter((record) => filter.workerId === undefined || record.workerId === filter.workerId)
      .filter((record) => filter.outcome === undefined || record.outcome === filter.outcome)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.dispatchId.localeCompare(right.dispatchId))
      .map(clone);
  }

  async create(run: RuntimeFleetConvergenceDispatchRun): Promise<RuntimeFleetConvergenceDispatchRun> {
    validateRuntimeFleetConvergenceDispatchRun(run);
    if (this.#records.has(run.dispatchId)) {
      throw new ConcurrencyError(`Runtime fleet convergence dispatch '${run.dispatchId}' already exists.`);
    }
    this.#records.set(run.dispatchId, clone(run));
    return clone(run);
  }
}

export interface RuntimeFleetConvergenceDispatchRequest {
  readonly dispatchId: string;
  readonly workerId: string;
  /** Omit to dispatch pending work from the whole queue. */
  readonly workIds?: readonly string[];
  /** Optional action filter when selecting from the queue. */
  readonly actions?: readonly RuntimeFleetConvergenceAction[];
  /** Maximum work items processed by one invocation. Defaults to 100. */
  readonly maxItems?: number;
}

export type RuntimeFleetConvergenceDispatchClock = () => Date;

/**
 * Explicit, bounded fleet dispatcher over M34/M35. This class does not schedule
 * itself and does not retry/recover blocked work automatically.
 */
export class RuntimeFleetConvergenceDispatcher {
  constructor(
    private readonly convergence: RuntimeFleetConvergenceCatalog,
    private readonly runner: RuntimeFleetConvergenceRunner,
    private readonly runs: RuntimeFleetConvergenceDispatchStore,
    private readonly clock: RuntimeFleetConvergenceDispatchClock = () => new Date(),
  ) {}

  async dispatch(request: RuntimeFleetConvergenceDispatchRequest): Promise<RuntimeFleetConvergenceDispatchRun> {
    assertText(request.dispatchId, "dispatchId");
    assertText(request.workerId, "workerId");
    if (await this.runs.get(request.dispatchId)) {
      throw new ConcurrencyError(`Runtime fleet convergence dispatch '${request.dispatchId}' already exists.`);
    }
    const maxItems = request.maxItems ?? 100;
    if (!Number.isSafeInteger(maxItems) || maxItems < 1) {
      throw new MetadataError("Runtime fleet convergence dispatch maxItems must be a positive integer.");
    }

    const startedAt = this.clock().toISOString();
    const work = await this.resolveWork(request);
    const items: RuntimeFleetConvergenceDispatchItem[] = [];

    for (const candidate of work.slice(0, maxItems)) {
      const revisionBefore = candidate.revision;
      try {
        const result = await this.runner.run(candidate.workId, request.workerId);
        if (result.work.status === "completed") {
          items.push({
            workId: candidate.workId,
            runtimeId: candidate.runtimeId,
            action: candidate.action,
            workRevisionBefore: revisionBefore,
            status: "completed",
            finalWorkStatus: result.work.status,
            ...(result.execution === undefined ? {} : { executionId: result.execution.executionId }),
          });
        } else {
          items.push({
            workId: candidate.workId,
            runtimeId: candidate.runtimeId,
            action: candidate.action,
            workRevisionBefore: revisionBefore,
            status: "blocked",
            finalWorkStatus: result.work.status,
            ...(result.execution === undefined ? {} : { executionId: result.execution.executionId }),
            ...(result.blockedReason === undefined ? {} : { blockedReason: result.blockedReason }),
          });
        }
      } catch (error) {
        items.push({
          workId: candidate.workId,
          runtimeId: candidate.runtimeId,
          action: candidate.action,
          workRevisionBefore: revisionBefore,
          status: "failed",
          error: errorMessage(error),
        });
      }
    }

    const completed = items.filter((item) => item.status === "completed").length;
    const blocked = items.filter((item) => item.status === "blocked").length;
    const failed = items.filter((item) => item.status === "failed").length;
    const outcome: RuntimeFleetConvergenceDispatchOutcome = failed === items.length && items.length > 0
      ? "failed"
      : blocked > 0 || failed > 0
        ? "partial"
        : "completed";

    return this.runs.create({
      format: "nublox-metaobject-runtime-fleet-convergence-dispatch",
      formatVersion: 1,
      dispatchId: request.dispatchId,
      workerId: request.workerId,
      outcome,
      items,
      total: items.length,
      completed,
      blocked,
      failed,
      startedAt,
      completedAt: this.clock().toISOString(),
    });
  }

  async get(dispatchId: string): Promise<RuntimeFleetConvergenceDispatchRun | null> {
    assertText(dispatchId, "dispatchId");
    return this.runs.get(dispatchId);
  }

  async history(filter: RuntimeFleetConvergenceDispatchFilter = {}): Promise<readonly RuntimeFleetConvergenceDispatchRun[]> {
    return this.runs.list(filter);
  }

  private async resolveWork(request: RuntimeFleetConvergenceDispatchRequest): Promise<readonly RuntimeFleetConvergenceWorkItem[]> {
    const actions = request.actions === undefined ? undefined : new Set(request.actions);
    if (actions?.size !== request.actions?.length) {
      throw new MetadataError("Runtime fleet convergence dispatch contains duplicate action filters.");
    }

    let records: RuntimeFleetConvergenceWorkItem[];
    if (request.workIds === undefined) {
      records = [...await this.convergence.list({ status: "pending" })];
    } else {
      const seen = new Set<string>();
      records = [];
      for (const workId of request.workIds) {
        assertText(workId, "workId");
        if (seen.has(workId)) {
          throw new MetadataError(`Runtime fleet convergence dispatch contains duplicate work '${workId}'.`);
        }
        seen.add(workId);
        const record = await this.convergence.get(workId);
        if (!record) throw new MetadataError(`Unknown runtime fleet convergence work '${workId}'.`);
        records.push(record);
      }
    }

    return records
      .filter((record) => actions === undefined || actions.has(record.action))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.workId.localeCompare(right.workId));
  }
}

function assertText(value: string, label: string): void {
  if (!value.trim()) throw new MetadataError(`Runtime fleet convergence dispatch ${label} is required.`);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "Runtime fleet convergence dispatch failed with an unknown error.";
}

const validOutcomes = new Set<RuntimeFleetConvergenceDispatchOutcome>(["completed", "partial", "failed"]);
const validItemStatuses = new Set<RuntimeFleetConvergenceDispatchItemStatus>(["completed", "blocked", "failed"]);

export function validateRuntimeFleetConvergenceDispatchRun(run: RuntimeFleetConvergenceDispatchRun): void {
  if (run.format !== "nublox-metaobject-runtime-fleet-convergence-dispatch" || run.formatVersion !== 1) {
    throw new MetadataError("Unsupported runtime fleet convergence dispatch format.");
  }
  assertText(run.dispatchId, "dispatchId");
  assertText(run.workerId, "workerId");
  assertText(run.startedAt, "startedAt");
  assertText(run.completedAt, "completedAt");
  if (!validOutcomes.has(run.outcome)) {
    throw new MetadataError(`Invalid runtime fleet convergence dispatch outcome '${String(run.outcome)}'.`);
  }
  if (!Number.isSafeInteger(run.total) || run.total < 0) throw new MetadataError("Runtime fleet convergence dispatch total must be non-negative.");
  for (const value of [run.completed, run.blocked, run.failed]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new MetadataError("Runtime fleet convergence dispatch counters must be non-negative integers.");
  }
  if (run.total !== run.items.length || run.total !== run.completed + run.blocked + run.failed) {
    throw new MetadataError("Runtime fleet convergence dispatch counters do not match items.");
  }
  const workIds = new Set<string>();
  for (const item of run.items) {
    assertText(item.workId, "item workId");
    assertText(item.runtimeId, "item runtimeId");
    if (!Number.isSafeInteger(item.workRevisionBefore) || item.workRevisionBefore < 1) {
      throw new MetadataError("Runtime fleet convergence dispatch workRevisionBefore must be a positive integer.");
    }
    if (!validItemStatuses.has(item.status)) {
      throw new MetadataError(`Invalid runtime fleet convergence dispatch item status '${String(item.status)}'.`);
    }
    if (workIds.has(item.workId)) throw new MetadataError(`Runtime fleet convergence dispatch contains duplicate work '${item.workId}'.`);
    workIds.add(item.workId);
    if (item.status === "completed" && item.finalWorkStatus !== "completed") {
      throw new MetadataError("Completed dispatch item must reference completed work.");
    }
    if (item.status === "blocked" && item.error !== undefined) {
      throw new MetadataError("Blocked dispatch item cannot contain an error.");
    }
    if (item.status === "failed" && !item.error?.trim()) {
      throw new MetadataError("Failed dispatch item requires an error.");
    }
  }
}
