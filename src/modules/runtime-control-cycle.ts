import { ConcurrencyError, MetadataError } from "../errors/errors.js";
import type { RuntimeDeploymentDriftAssessment } from "./runtime-deployment-drift.js";
import type { RuntimePostureResponseRecord } from "./runtime-posture-response.js";
import type { RuntimePostureCaptureRequest, RuntimePostureSnapshot } from "./runtime-posture.js";

export type RuntimeControlCycleStatus = "completed" | "failed";
export type RuntimeControlCycleStage = "assessment" | "posture" | "response";

export interface RuntimeControlCycleRecord {
  readonly format: "nublox-metaobject-runtime-control-cycle";
  readonly formatVersion: 1;
  readonly cycleId: string;
  readonly runtimeId: string;
  readonly baselineId: string;
  readonly assessmentId: string;
  readonly snapshotId: string;
  readonly responseId: string;
  readonly status: RuntimeControlCycleStatus;
  readonly assessmentOutcome?: RuntimeDeploymentDriftAssessment["outcome"];
  readonly postureState?: RuntimePostureSnapshot["state"];
  readonly responseDisposition?: RuntimePostureResponseRecord["disposition"];
  readonly failedStage?: RuntimeControlCycleStage;
  readonly error?: string;
  readonly startedAt: string;
  readonly completedAt: string;
}

export interface RuntimeControlCycleFilter {
  readonly runtimeId?: string;
  readonly status?: RuntimeControlCycleStatus;
}

export interface RuntimeControlCycleStore {
  get(cycleId: string): Promise<RuntimeControlCycleRecord | null>;
  list(filter?: RuntimeControlCycleFilter): Promise<readonly RuntimeControlCycleRecord[]>;
  create(record: RuntimeControlCycleRecord): Promise<RuntimeControlCycleRecord>;
}

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryRuntimeControlCycleStore implements RuntimeControlCycleStore {
  readonly #records = new Map<string, RuntimeControlCycleRecord>();

  async get(cycleId: string): Promise<RuntimeControlCycleRecord | null> {
    const record = this.#records.get(cycleId);
    return record ? clone(record) : null;
  }

  async list(filter: RuntimeControlCycleFilter = {}): Promise<readonly RuntimeControlCycleRecord[]> {
    return [...this.#records.values()]
      .filter((record) => filter.runtimeId === undefined || record.runtimeId === filter.runtimeId)
      .filter((record) => filter.status === undefined || record.status === filter.status)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.cycleId.localeCompare(right.cycleId))
      .map(clone);
  }

  async create(record: RuntimeControlCycleRecord): Promise<RuntimeControlCycleRecord> {
    validateRuntimeControlCycleRecord(record);
    if (this.#records.has(record.cycleId)) {
      throw new ConcurrencyError(`Runtime control cycle '${record.cycleId}' already exists.`);
    }
    this.#records.set(record.cycleId, clone(record));
    return clone(record);
  }
}

export interface RuntimeControlDriftAssessor {
  assess(baselineId: string, assessmentId: string): Promise<RuntimeDeploymentDriftAssessment>;
}

export interface RuntimeControlPostureCapturer {
  capture(request: RuntimePostureCaptureRequest): Promise<RuntimePostureSnapshot>;
}

export interface RuntimeControlPostureResponder {
  evaluate(request: {
    readonly responseId: string;
    readonly snapshotId: string;
    readonly remediationPlanId?: string;
  }): Promise<RuntimePostureResponseRecord>;
}

export interface RuntimeControlCycleRequest {
  readonly cycleId: string;
  readonly runtimeId: string;
  readonly baselineId: string;
  readonly assessmentId: string;
  readonly snapshotId: string;
  readonly responseId: string;
  readonly remediationCaseId?: string;
  readonly remediationPlanId?: string;
}

export type RuntimeControlCycleClock = () => Date;

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "unknown error";
}

/**
 * Execute one governed control cycle: M23 assessment -> M26 posture -> M28 response.
 * Each underlying stage keeps its own immutable evidence; the cycle record links
 * them and records a failed stage if orchestration cannot complete.
 */
export class RuntimeControlCycleCatalog {
  constructor(
    private readonly cycles: RuntimeControlCycleStore,
    private readonly drift: RuntimeControlDriftAssessor,
    private readonly posture: RuntimeControlPostureCapturer,
    private readonly responses: RuntimeControlPostureResponder,
    private readonly clock: RuntimeControlCycleClock = () => new Date(),
  ) {}

  async run(request: RuntimeControlCycleRequest): Promise<RuntimeControlCycleRecord> {
    for (const [label, value] of Object.entries({
      cycleId: request.cycleId,
      runtimeId: request.runtimeId,
      baselineId: request.baselineId,
      assessmentId: request.assessmentId,
      snapshotId: request.snapshotId,
      responseId: request.responseId,
    })) {
      if (!value.trim()) throw new MetadataError(`Runtime control cycle ${label} is required.`);
    }
    if (await this.cycles.get(request.cycleId)) {
      throw new ConcurrencyError(`Runtime control cycle '${request.cycleId}' already exists.`);
    }

    const startedAt = this.clock().toISOString();
    let assessment: RuntimeDeploymentDriftAssessment;
    try {
      assessment = await this.drift.assess(request.baselineId, request.assessmentId);
    } catch (error) {
      return this.fail(request, "assessment", error, startedAt);
    }

    let snapshot: RuntimePostureSnapshot;
    try {
      snapshot = await this.posture.capture({
        snapshotId: request.snapshotId,
        runtimeId: request.runtimeId,
        baselineId: request.baselineId,
        assessmentId: request.assessmentId,
        ...(request.remediationCaseId === undefined ? {} : { remediationCaseId: request.remediationCaseId }),
      });
      if (snapshot.runtimeId !== request.runtimeId || snapshot.assessmentId !== assessment.assessmentId) {
        throw new MetadataError("Runtime control cycle posture result does not match the requested runtime/assessment identity.");
      }
    } catch (error) {
      return this.fail(request, "posture", error, startedAt, assessment);
    }

    let response: RuntimePostureResponseRecord;
    try {
      response = await this.responses.evaluate({
        responseId: request.responseId,
        snapshotId: request.snapshotId,
        ...(request.remediationPlanId === undefined ? {} : { remediationPlanId: request.remediationPlanId }),
      });
      if (response.runtimeId !== request.runtimeId || response.snapshotId !== snapshot.snapshotId) {
        throw new MetadataError("Runtime control cycle response does not match the requested runtime/posture identity.");
      }
    } catch (error) {
      return this.fail(request, "response", error, startedAt, assessment, snapshot);
    }

    const completedAt = this.clock().toISOString();
    return this.cycles.create({
      format: "nublox-metaobject-runtime-control-cycle",
      formatVersion: 1,
      cycleId: request.cycleId,
      runtimeId: request.runtimeId,
      baselineId: request.baselineId,
      assessmentId: assessment.assessmentId,
      snapshotId: snapshot.snapshotId,
      responseId: response.responseId,
      status: "completed",
      assessmentOutcome: assessment.outcome,
      postureState: snapshot.state,
      responseDisposition: response.disposition,
      startedAt,
      completedAt,
    });
  }

  async get(cycleId: string): Promise<RuntimeControlCycleRecord | null> {
    return this.cycles.get(cycleId);
  }

  async history(runtimeId: string): Promise<readonly RuntimeControlCycleRecord[]> {
    if (!runtimeId.trim()) throw new MetadataError("Runtime control cycle runtimeId is required.");
    return this.cycles.list({ runtimeId });
  }

  private async fail(
    request: RuntimeControlCycleRequest,
    failedStage: RuntimeControlCycleStage,
    error: unknown,
    startedAt: string,
    assessment?: RuntimeDeploymentDriftAssessment,
    snapshot?: RuntimePostureSnapshot,
  ): Promise<RuntimeControlCycleRecord> {
    const completedAt = this.clock().toISOString();
    return this.cycles.create({
      format: "nublox-metaobject-runtime-control-cycle",
      formatVersion: 1,
      cycleId: request.cycleId,
      runtimeId: request.runtimeId,
      baselineId: request.baselineId,
      assessmentId: assessment?.assessmentId ?? request.assessmentId,
      snapshotId: snapshot?.snapshotId ?? request.snapshotId,
      responseId: request.responseId,
      status: "failed",
      ...(assessment === undefined ? {} : { assessmentOutcome: assessment.outcome }),
      ...(snapshot === undefined ? {} : { postureState: snapshot.state }),
      failedStage,
      error: errorMessage(error),
      startedAt,
      completedAt,
    });
  }
}

export function validateRuntimeControlCycleRecord(record: RuntimeControlCycleRecord): void {
  if (record.format !== "nublox-metaobject-runtime-control-cycle" || record.formatVersion !== 1) {
    throw new MetadataError("Unsupported runtime control cycle format.");
  }
  for (const value of [record.cycleId, record.runtimeId, record.baselineId, record.assessmentId, record.snapshotId, record.responseId]) {
    if (!value.trim()) throw new MetadataError("Runtime control cycle identity fields are required.");
  }
  if (!record.startedAt.trim() || !record.completedAt.trim()) {
    throw new MetadataError("Runtime control cycle timestamps are required.");
  }
  if (record.status === "completed") {
    if (record.assessmentOutcome === undefined || record.postureState === undefined || record.responseDisposition === undefined) {
      throw new MetadataError("Completed runtime control cycles require assessment, posture and response outcomes.");
    }
    if (record.failedStage !== undefined || record.error !== undefined) {
      throw new MetadataError("Completed runtime control cycles cannot contain failure state.");
    }
  } else {
    if (record.failedStage === undefined || !record.error?.trim()) {
      throw new MetadataError("Failed runtime control cycles require failedStage and error.");
    }
  }
}
