import { ConcurrencyError, MetadataError } from "../errors/errors.js";
import type {
  RuntimeFleetRecommendedAction,
  RuntimeFleetReconciliationRun,
  RuntimeFleetReconciliationTarget,
} from "./runtime-fleet-reconciliation.js";
import { validateRuntimeFleetReconciliationRun } from "./runtime-fleet-reconciliation.js";
import type { RuntimeTargetStore } from "./runtime-registry.js";

export type RuntimeFleetConvergenceAction = Exclude<RuntimeFleetRecommendedAction, "none">;
export type RuntimeFleetConvergenceWorkStatus = "pending" | "in-progress" | "completed" | "failed" | "cancelled";

export interface RuntimeFleetConvergenceWorkItem {
  readonly format: "nublox-metaobject-runtime-fleet-convergence-work";
  readonly formatVersion: 1;
  readonly workId: string;
  readonly revision: number;
  readonly reconciliationRunId: string;
  readonly runtimeId: string;
  readonly targetRevision: number;
  readonly action: RuntimeFleetConvergenceAction;
  readonly reason: string;
  readonly status: RuntimeFleetConvergenceWorkStatus;
  readonly claimedBy?: string;
  readonly claimedAt?: string;
  readonly finishedAt?: string;
  readonly result?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RuntimeFleetConvergenceWorkFilter {
  readonly reconciliationRunId?: string;
  readonly runtimeId?: string;
  readonly action?: RuntimeFleetConvergenceAction;
  readonly status?: RuntimeFleetConvergenceWorkStatus;
}

export interface RuntimeFleetConvergenceWorkStore {
  get(workId: string): Promise<RuntimeFleetConvergenceWorkItem | null>;
  list(filter?: RuntimeFleetConvergenceWorkFilter): Promise<readonly RuntimeFleetConvergenceWorkItem[]>;
  createMany(items: readonly RuntimeFleetConvergenceWorkItem[]): Promise<readonly RuntimeFleetConvergenceWorkItem[]>;
  save(item: RuntimeFleetConvergenceWorkItem, expectedRevision: number): Promise<RuntimeFleetConvergenceWorkItem>;
}

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryRuntimeFleetConvergenceWorkStore implements RuntimeFleetConvergenceWorkStore {
  readonly #records = new Map<string, RuntimeFleetConvergenceWorkItem>();

  async get(workId: string): Promise<RuntimeFleetConvergenceWorkItem | null> {
    const record = this.#records.get(workId);
    return record ? clone(record) : null;
  }

  async list(filter: RuntimeFleetConvergenceWorkFilter = {}): Promise<readonly RuntimeFleetConvergenceWorkItem[]> {
    return [...this.#records.values()]
      .filter((record) => filter.reconciliationRunId === undefined || record.reconciliationRunId === filter.reconciliationRunId)
      .filter((record) => filter.runtimeId === undefined || record.runtimeId === filter.runtimeId)
      .filter((record) => filter.action === undefined || record.action === filter.action)
      .filter((record) => filter.status === undefined || record.status === filter.status)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.workId.localeCompare(right.workId))
      .map(clone);
  }

  async createMany(items: readonly RuntimeFleetConvergenceWorkItem[]): Promise<readonly RuntimeFleetConvergenceWorkItem[]> {
    const ids = new Set<string>();
    for (const item of items) {
      validateRuntimeFleetConvergenceWorkItem(item);
      if (ids.has(item.workId)) {
        throw new MetadataError(`Runtime fleet convergence batch contains duplicate work id '${item.workId}'.`);
      }
      ids.add(item.workId);
      if (this.#records.has(item.workId)) {
        throw new ConcurrencyError(`Runtime fleet convergence work '${item.workId}' already exists.`);
      }
    }

    const stored = items.map((item) => clone({ ...item, revision: 1 }));
    for (const item of stored) this.#records.set(item.workId, item);
    return stored.map(clone);
  }

  async save(item: RuntimeFleetConvergenceWorkItem, expectedRevision: number): Promise<RuntimeFleetConvergenceWorkItem> {
    validateRuntimeFleetConvergenceWorkItem(item);
    const current = this.#records.get(item.workId);
    if (!current) throw new MetadataError(`Unknown runtime fleet convergence work '${item.workId}'.`);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new MetadataError("Runtime fleet convergence expectedRevision must be a positive integer.");
    }
    if (current.revision !== expectedRevision) {
      throw new ConcurrencyError(
        `Runtime fleet convergence conflict for '${item.workId}': expected revision ${expectedRevision}, found ${current.revision}.`,
      );
    }
    for (const [label, before, after] of [
      ["reconciliationRunId", current.reconciliationRunId, item.reconciliationRunId],
      ["runtimeId", current.runtimeId, item.runtimeId],
      ["targetRevision", current.targetRevision, item.targetRevision],
      ["action", current.action, item.action],
      ["createdAt", current.createdAt, item.createdAt],
    ] as const) {
      if (before !== after) throw new MetadataError(`Runtime fleet convergence work '${item.workId}' ${label} is immutable.`);
    }

    const stored = clone({ ...item, revision: current.revision + 1 });
    this.#records.set(stored.workId, stored);
    return clone(stored);
  }
}

export interface RuntimeFleetReconciliationSource {
  get(runId: string): Promise<RuntimeFleetReconciliationRun | null>;
}

export type RuntimeFleetConvergenceClock = () => Date;
export type RuntimeFleetConvergenceWorkIdFactory = (
  reconciliationRunId: string,
  target: RuntimeFleetReconciliationTarget,
) => string;

function defaultWorkId(reconciliationRunId: string, target: RuntimeFleetReconciliationTarget): string {
  return `work:${encodeURIComponent(reconciliationRunId)}:${encodeURIComponent(target.runtimeId)}:${target.recommendedAction}`;
}

/**
 * Turn immutable M33 recommendations into durable work coordination records.
 * External workers own the actual M16/M24/M29 activity; this catalog only
 * materializes, leases and records completion/failure of those work items.
 */
export class RuntimeFleetConvergenceCatalog {
  constructor(
    private readonly work: RuntimeFleetConvergenceWorkStore,
    private readonly reconciliations: RuntimeFleetReconciliationSource,
    private readonly targets: RuntimeTargetStore,
    private readonly clock: RuntimeFleetConvergenceClock = () => new Date(),
    private readonly workIdFactory: RuntimeFleetConvergenceWorkIdFactory = defaultWorkId,
  ) {}

  async materialize(reconciliationRunId: string): Promise<readonly RuntimeFleetConvergenceWorkItem[]> {
    assertIdentity(reconciliationRunId, "reconciliationRunId");
    const run = await this.reconciliations.get(reconciliationRunId);
    if (!run) throw new MetadataError(`Unknown runtime fleet reconciliation '${reconciliationRunId}'.`);
    validateRuntimeFleetReconciliationRun(run);
    const now = this.clock().toISOString();
    const items = run.targets
      .filter((target): target is RuntimeFleetReconciliationTarget & { recommendedAction: RuntimeFleetConvergenceAction } => target.recommendedAction !== "none")
      .map((target) => ({
        format: "nublox-metaobject-runtime-fleet-convergence-work" as const,
        formatVersion: 1 as const,
        workId: this.workIdFactory(run.runId, target),
        revision: 0,
        reconciliationRunId: run.runId,
        runtimeId: target.runtimeId,
        targetRevision: target.targetRevision,
        action: target.recommendedAction,
        reason: target.reason,
        status: "pending" as const,
        createdAt: now,
        updatedAt: now,
      }));
    return this.work.createMany(items);
  }

  async claim(workId: string, workerId: string, expectedRevision: number): Promise<RuntimeFleetConvergenceWorkItem> {
    const current = await this.requireWork(workId);
    assertIdentity(workerId, "workerId");
    if (current.status !== "pending") {
      throw new MetadataError(`Runtime fleet convergence work '${workId}' is '${current.status}' and cannot be claimed.`);
    }
    const target = await this.targets.get(current.runtimeId);
    if (!target) throw new MetadataError(`Runtime target '${current.runtimeId}' no longer exists.`);
    if (target.status !== "active") throw new MetadataError(`Runtime target '${current.runtimeId}' is retired.`);
    if (target.revision !== current.targetRevision) {
      throw new ConcurrencyError(
        `Runtime fleet convergence work '${workId}' is stale: target revision ${current.targetRevision}, current revision ${target.revision}.`,
      );
    }
    const now = this.clock().toISOString();
    return this.work.save({
      ...current,
      status: "in-progress",
      claimedBy: workerId,
      claimedAt: now,
      updatedAt: now,
    }, expectedRevision);
  }

  async complete(workId: string, result: string, expectedRevision: number): Promise<RuntimeFleetConvergenceWorkItem> {
    const current = await this.requireInProgress(workId);
    assertIdentity(result, "result");
    const now = this.clock().toISOString();
    return this.work.save({
      ...current,
      status: "completed",
      result,
      finishedAt: now,
      updatedAt: now,
    }, expectedRevision);
  }

  async fail(workId: string, error: string, expectedRevision: number): Promise<RuntimeFleetConvergenceWorkItem> {
    const current = await this.requireInProgress(workId);
    assertIdentity(error, "error");
    const now = this.clock().toISOString();
    return this.work.save({
      ...current,
      status: "failed",
      result: error,
      finishedAt: now,
      updatedAt: now,
    }, expectedRevision);
  }

  async retry(workId: string, expectedRevision: number): Promise<RuntimeFleetConvergenceWorkItem> {
    const current = await this.requireWork(workId);
    if (current.status !== "failed") {
      throw new MetadataError(`Runtime fleet convergence work '${workId}' is '${current.status}' and cannot be retried.`);
    }
    return this.work.save({
      format: current.format,
      formatVersion: current.formatVersion,
      workId: current.workId,
      revision: current.revision,
      reconciliationRunId: current.reconciliationRunId,
      runtimeId: current.runtimeId,
      targetRevision: current.targetRevision,
      action: current.action,
      reason: current.reason,
      status: "pending",
      createdAt: current.createdAt,
      updatedAt: this.clock().toISOString(),
    }, expectedRevision);
  }

  async cancel(workId: string, reason: string, expectedRevision: number): Promise<RuntimeFleetConvergenceWorkItem> {
    const current = await this.requireWork(workId);
    assertIdentity(reason, "reason");
    if (current.status !== "pending") {
      throw new MetadataError(`Runtime fleet convergence work '${workId}' is '${current.status}' and cannot be cancelled.`);
    }
    const now = this.clock().toISOString();
    return this.work.save({
      ...current,
      status: "cancelled",
      result: reason,
      finishedAt: now,
      updatedAt: now,
    }, expectedRevision);
  }

  async get(workId: string): Promise<RuntimeFleetConvergenceWorkItem | null> {
    assertIdentity(workId, "workId");
    return this.work.get(workId);
  }

  async list(filter: RuntimeFleetConvergenceWorkFilter = {}): Promise<readonly RuntimeFleetConvergenceWorkItem[]> {
    return this.work.list(filter);
  }

  private async requireWork(workId: string): Promise<RuntimeFleetConvergenceWorkItem> {
    assertIdentity(workId, "workId");
    const current = await this.work.get(workId);
    if (!current) throw new MetadataError(`Unknown runtime fleet convergence work '${workId}'.`);
    return current;
  }

  private async requireInProgress(workId: string): Promise<RuntimeFleetConvergenceWorkItem> {
    const current = await this.requireWork(workId);
    if (current.status !== "in-progress") {
      throw new MetadataError(`Runtime fleet convergence work '${workId}' is '${current.status}' and is not in progress.`);
    }
    return current;
  }
}

function assertIdentity(value: string, label: string): void {
  if (!value.trim()) throw new MetadataError(`Runtime fleet convergence ${label} is required.`);
}

const validActions = new Set<RuntimeFleetConvergenceAction>([
  "establish-observation",
  "plan-profile-upgrade",
  "reassess",
  "plan-remediation",
  "wait-remediation",
  "review",
]);
const validStatuses = new Set<RuntimeFleetConvergenceWorkStatus>([
  "pending",
  "in-progress",
  "completed",
  "failed",
  "cancelled",
]);

export function validateRuntimeFleetConvergenceWorkItem(item: RuntimeFleetConvergenceWorkItem): void {
  if (item.format !== "nublox-metaobject-runtime-fleet-convergence-work" || item.formatVersion !== 1) {
    throw new MetadataError("Unsupported runtime fleet convergence work format.");
  }
  for (const [label, value] of Object.entries({
    workId: item.workId,
    reconciliationRunId: item.reconciliationRunId,
    runtimeId: item.runtimeId,
    reason: item.reason,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  })) {
    assertIdentity(value, label);
  }
  if (!Number.isSafeInteger(item.revision) || item.revision < 0) {
    throw new MetadataError("Runtime fleet convergence revision must be a non-negative integer.");
  }
  if (!Number.isSafeInteger(item.targetRevision) || item.targetRevision < 1) {
    throw new MetadataError("Runtime fleet convergence targetRevision must be a positive integer.");
  }
  if (!validActions.has(item.action)) {
    throw new MetadataError(`Invalid runtime fleet convergence action '${String(item.action)}'.`);
  }
  if (!validStatuses.has(item.status)) {
    throw new MetadataError(`Invalid runtime fleet convergence status '${String(item.status)}'.`);
  }

  if (item.status === "pending") {
    if (item.claimedBy !== undefined || item.claimedAt !== undefined || item.finishedAt !== undefined || item.result !== undefined) {
      throw new MetadataError("Pending runtime fleet convergence work cannot contain claim or result state.");
    }
  } else if (item.status === "in-progress") {
    if (!item.claimedBy?.trim() || !item.claimedAt?.trim()) {
      throw new MetadataError("In-progress runtime fleet convergence work requires claim identity and timestamp.");
    }
    if (item.finishedAt !== undefined || item.result !== undefined) {
      throw new MetadataError("In-progress runtime fleet convergence work cannot contain terminal result state.");
    }
  } else {
    if (!item.finishedAt?.trim() || !item.result?.trim()) {
      throw new MetadataError(`Terminal runtime fleet convergence work '${item.status}' requires finishedAt and result.`);
    }
    if ((item.status === "completed" || item.status === "failed") && (!item.claimedBy?.trim() || !item.claimedAt?.trim())) {
      throw new MetadataError(`Runtime fleet convergence work '${item.status}' requires prior claim identity.`);
    }
    if (item.status === "cancelled" && (item.claimedBy !== undefined || item.claimedAt !== undefined)) {
      throw new MetadataError("Cancelled runtime fleet convergence work cannot contain claim state.");
    }
  }
}
