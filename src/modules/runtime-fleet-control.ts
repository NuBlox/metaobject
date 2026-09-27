import { ConcurrencyError, MetadataError } from "../errors/errors.js";
import type { RuntimeControlCycleRecord, RuntimeControlCycleRequest } from "./runtime-control-cycle.js";
import type { RuntimeTargetRecord } from "./runtime-registry.js";

export type RuntimeFleetControlTargetStatus = "completed" | "cycle-failed" | "registry-failed";
export type RuntimeFleetControlRunStatus = "completed" | "partial" | "failed";

export interface RuntimeFleetControlTargetRequest extends Omit<RuntimeControlCycleRequest, "runtimeId"> {
  readonly runtimeId: string;
  readonly expectedTargetRevision: number;
}

export interface RuntimeFleetControlTargetResult {
  readonly runtimeId: string;
  readonly cycleId: string;
  readonly expectedTargetRevision: number;
  readonly status: RuntimeFleetControlTargetStatus;
  readonly cycleStatus?: RuntimeControlCycleRecord["status"];
  readonly targetRevision?: number;
  readonly error?: string;
}

export interface RuntimeFleetControlRunRecord {
  readonly format: "nublox-metaobject-runtime-fleet-control-run";
  readonly formatVersion: 1;
  readonly fleetRunId: string;
  readonly status: RuntimeFleetControlRunStatus;
  readonly targets: readonly RuntimeFleetControlTargetResult[];
  readonly startedAt: string;
  readonly completedAt: string;
}

export interface RuntimeFleetControlRunFilter {
  readonly status?: RuntimeFleetControlRunStatus;
  readonly runtimeId?: string;
}

export interface RuntimeFleetControlRunStore {
  get(fleetRunId: string): Promise<RuntimeFleetControlRunRecord | null>;
  list(filter?: RuntimeFleetControlRunFilter): Promise<readonly RuntimeFleetControlRunRecord[]>;
  create(record: RuntimeFleetControlRunRecord): Promise<RuntimeFleetControlRunRecord>;
}

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryRuntimeFleetControlRunStore implements RuntimeFleetControlRunStore {
  readonly #records = new Map<string, RuntimeFleetControlRunRecord>();

  async get(fleetRunId: string): Promise<RuntimeFleetControlRunRecord | null> {
    const record = this.#records.get(fleetRunId);
    return record ? clone(record) : null;
  }

  async list(filter: RuntimeFleetControlRunFilter = {}): Promise<readonly RuntimeFleetControlRunRecord[]> {
    return [...this.#records.values()]
      .filter((record) => filter.status === undefined || record.status === filter.status)
      .filter((record) => filter.runtimeId === undefined || record.targets.some((target) => target.runtimeId === filter.runtimeId))
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.fleetRunId.localeCompare(right.fleetRunId))
      .map(clone);
  }

  async create(record: RuntimeFleetControlRunRecord): Promise<RuntimeFleetControlRunRecord> {
    validateRuntimeFleetControlRunRecord(record);
    if (this.#records.has(record.fleetRunId)) {
      throw new ConcurrencyError(`Runtime fleet control run '${record.fleetRunId}' already exists.`);
    }
    const stored = clone(record);
    this.#records.set(record.fleetRunId, stored);
    return clone(stored);
  }
}

export interface RuntimeFleetControlCycleRunner {
  run(request: RuntimeControlCycleRequest): Promise<RuntimeControlCycleRecord>;
}

export interface RuntimeFleetTargetRegistry {
  get(runtimeId: string): Promise<RuntimeTargetRecord | null>;
  observeControlCycle(runtimeId: string, cycleId: string, expectedRevision: number): Promise<RuntimeTargetRecord>;
}

export interface RuntimeFleetControlRunRequest {
  readonly fleetRunId: string;
  readonly targets: readonly RuntimeFleetControlTargetRequest[];
}

export type RuntimeFleetControlClock = () => Date;

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "unknown error";
}

function overallStatus(results: readonly RuntimeFleetControlTargetResult[]): RuntimeFleetControlRunStatus {
  const completed = results.filter((result) => result.status === "completed").length;
  if (completed === results.length) return "completed";
  if (completed === 0) return "failed";
  return "partial";
}

/**
 * Execute one explicit batch of M29 control cycles across registered runtimes.
 * Targets are isolated: a failure on one runtime never prevents the remaining
 * requested runtimes from running. This class does not schedule future runs.
 */
export class RuntimeFleetControlCatalog {
  constructor(
    private readonly runs: RuntimeFleetControlRunStore,
    private readonly registry: RuntimeFleetTargetRegistry,
    private readonly cycles: RuntimeFleetControlCycleRunner,
    private readonly clock: RuntimeFleetControlClock = () => new Date(),
  ) {}

  async run(request: RuntimeFleetControlRunRequest): Promise<RuntimeFleetControlRunRecord> {
    validateRequest(request);
    if (await this.runs.get(request.fleetRunId)) {
      throw new ConcurrencyError(`Runtime fleet control run '${request.fleetRunId}' already exists.`);
    }

    const startedAt = this.clock().toISOString();
    const results: RuntimeFleetControlTargetResult[] = [];

    for (const target of request.targets) {
      const current = await this.registry.get(target.runtimeId);
      if (!current) {
        results.push(failedResult(target, "registry-failed", `Unknown runtime target '${target.runtimeId}'.`));
        continue;
      }
      if (current.status !== "active") {
        results.push(failedResult(target, "registry-failed", `Runtime target '${target.runtimeId}' is retired.`));
        continue;
      }
      if (current.revision !== target.expectedTargetRevision) {
        results.push(failedResult(
          target,
          "registry-failed",
          `Runtime target concurrency conflict for '${target.runtimeId}': expected revision ${target.expectedTargetRevision}, found ${current.revision}.`,
        ));
        continue;
      }

      let cycle: RuntimeControlCycleRecord;
      try {
        cycle = await this.cycles.run({
          cycleId: target.cycleId,
          runtimeId: target.runtimeId,
          baselineId: target.baselineId,
          assessmentId: target.assessmentId,
          snapshotId: target.snapshotId,
          responseId: target.responseId,
          ...(target.remediationCaseId === undefined ? {} : { remediationCaseId: target.remediationCaseId }),
          ...(target.remediationPlanId === undefined ? {} : { remediationPlanId: target.remediationPlanId }),
        });
      } catch (error) {
        results.push(failedResult(target, "cycle-failed", errorMessage(error)));
        continue;
      }

      try {
        const updated = await this.registry.observeControlCycle(target.runtimeId, cycle.cycleId, target.expectedTargetRevision);
        results.push({
          runtimeId: target.runtimeId,
          cycleId: target.cycleId,
          expectedTargetRevision: target.expectedTargetRevision,
          status: cycle.status === "completed" ? "completed" : "cycle-failed",
          cycleStatus: cycle.status,
          targetRevision: updated.revision,
          ...(cycle.status === "failed" ? { error: cycle.error ?? "Control cycle failed." } : {}),
        });
      } catch (error) {
        results.push({
          runtimeId: target.runtimeId,
          cycleId: target.cycleId,
          expectedTargetRevision: target.expectedTargetRevision,
          status: "registry-failed",
          cycleStatus: cycle.status,
          error: errorMessage(error),
        });
      }
    }

    const record: RuntimeFleetControlRunRecord = {
      format: "nublox-metaobject-runtime-fleet-control-run",
      formatVersion: 1,
      fleetRunId: request.fleetRunId,
      status: overallStatus(results),
      targets: results,
      startedAt,
      completedAt: this.clock().toISOString(),
    };
    return this.runs.create(record);
  }

  async get(fleetRunId: string): Promise<RuntimeFleetControlRunRecord | null> {
    if (!fleetRunId.trim()) throw new MetadataError("Runtime fleet control run id is required.");
    return this.runs.get(fleetRunId);
  }

  async history(runtimeId?: string): Promise<readonly RuntimeFleetControlRunRecord[]> {
    if (runtimeId !== undefined && !runtimeId.trim()) throw new MetadataError("Runtime fleet control runtimeId cannot be empty.");
    return this.runs.list(runtimeId === undefined ? {} : { runtimeId });
  }
}

function failedResult(
  target: RuntimeFleetControlTargetRequest,
  status: "cycle-failed" | "registry-failed",
  error: string,
): RuntimeFleetControlTargetResult {
  return {
    runtimeId: target.runtimeId,
    cycleId: target.cycleId,
    expectedTargetRevision: target.expectedTargetRevision,
    status,
    error,
  };
}

function validateRequest(request: RuntimeFleetControlRunRequest): void {
  if (!request.fleetRunId.trim()) throw new MetadataError("Runtime fleet control run id is required.");
  if (request.targets.length === 0) throw new MetadataError("Runtime fleet control run requires at least one target.");
  const runtimes = new Set<string>();
  const cycles = new Set<string>();
  for (const target of request.targets) {
    for (const [label, value] of Object.entries({
      runtimeId: target.runtimeId,
      cycleId: target.cycleId,
      baselineId: target.baselineId,
      assessmentId: target.assessmentId,
      snapshotId: target.snapshotId,
      responseId: target.responseId,
    })) {
      if (!value.trim()) throw new MetadataError(`Runtime fleet control target ${label} is required.`);
    }
    if (!Number.isSafeInteger(target.expectedTargetRevision) || target.expectedTargetRevision < 1) {
      throw new MetadataError("Runtime fleet control expectedTargetRevision must be a positive integer.");
    }
    if (runtimes.has(target.runtimeId)) throw new MetadataError(`Duplicate runtime target '${target.runtimeId}' in fleet control run.`);
    if (cycles.has(target.cycleId)) throw new MetadataError(`Duplicate control cycle id '${target.cycleId}' in fleet control run.`);
    runtimes.add(target.runtimeId);
    cycles.add(target.cycleId);
  }
}

export function validateRuntimeFleetControlRunRecord(record: RuntimeFleetControlRunRecord): void {
  if (record.format !== "nublox-metaobject-runtime-fleet-control-run" || record.formatVersion !== 1) {
    throw new MetadataError("Unsupported runtime fleet control run format.");
  }
  if (!record.fleetRunId.trim() || !record.startedAt.trim() || !record.completedAt.trim()) {
    throw new MetadataError("Runtime fleet control run identity/timestamps are required.");
  }
  if (record.targets.length === 0) throw new MetadataError("Runtime fleet control run requires target results.");
  const runtimeIds = new Set<string>();
  const cycleIds = new Set<string>();
  for (const target of record.targets) {
    if (!target.runtimeId.trim() || !target.cycleId.trim()) throw new MetadataError("Runtime fleet control target result identity is required.");
    if (!Number.isSafeInteger(target.expectedTargetRevision) || target.expectedTargetRevision < 1) {
      throw new MetadataError("Runtime fleet control target expectedTargetRevision must be a positive integer.");
    }
    if (runtimeIds.has(target.runtimeId) || cycleIds.has(target.cycleId)) {
      throw new MetadataError("Runtime fleet control target results must have unique runtime and cycle ids.");
    }
    runtimeIds.add(target.runtimeId);
    cycleIds.add(target.cycleId);
    if (target.status !== "completed" && target.status !== "cycle-failed" && target.status !== "registry-failed") {
      throw new MetadataError(`Invalid runtime fleet control target status '${String(target.status)}'.`);
    }
    if (target.status === "completed" && target.cycleStatus !== "completed") {
      throw new MetadataError("Completed runtime fleet control target requires a completed control cycle.");
    }
    if (target.status !== "completed" && !target.error?.trim()) {
      throw new MetadataError("Failed runtime fleet control target requires an error.");
    }
  }
  if (overallStatus(record.targets) !== record.status) {
    throw new MetadataError("Runtime fleet control run status does not match target results.");
  }
}
