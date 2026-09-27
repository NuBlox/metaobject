import { ConcurrencyError, MetadataError } from "../errors/errors.js";
import type {
  RuntimeTargetDesiredProfile,
  RuntimeTargetObservation,
  RuntimeTargetRecord,
  RuntimeTargetStore,
} from "./runtime-registry.js";
import type { RuntimePostureState } from "./runtime-posture.js";

export type RuntimeFleetComplianceState =
  | "compliant"
  | "unobserved"
  | "profile-behind"
  | "profile-ahead"
  | "profile-mismatch"
  | "warning"
  | "drifted"
  | "remediating"
  | "review"
  | "stale"
  | "retired";

export type RuntimeFleetRecommendedAction =
  | "none"
  | "establish-observation"
  | "plan-profile-upgrade"
  | "reassess"
  | "plan-remediation"
  | "wait-remediation"
  | "review";

export interface RuntimeFleetReconciliationTarget {
  readonly runtimeId: string;
  readonly targetRevision: number;
  readonly targetStatus: RuntimeTargetRecord["status"];
  readonly desiredProfile: RuntimeTargetDesiredProfile;
  readonly observedProfile?: RuntimeTargetDesiredProfile;
  readonly postureState?: RuntimePostureState;
  readonly compliance: RuntimeFleetComplianceState;
  readonly recommendedAction: RuntimeFleetRecommendedAction;
  readonly reason: string;
}

export type RuntimeFleetReconciliationOutcome = "compliant" | "action-required" | "review-required";

export interface RuntimeFleetReconciliationRun {
  readonly format: "nublox-metaobject-runtime-fleet-reconciliation";
  readonly formatVersion: 1;
  readonly runId: string;
  readonly outcome: RuntimeFleetReconciliationOutcome;
  readonly targets: readonly RuntimeFleetReconciliationTarget[];
  readonly total: number;
  readonly compliant: number;
  readonly actionRequired: number;
  readonly reviewRequired: number;
  readonly retired: number;
  readonly capturedAt: string;
}

export interface RuntimeFleetReconciliationFilter {
  readonly outcome?: RuntimeFleetReconciliationOutcome;
}

export interface RuntimeFleetReconciliationStore {
  get(runId: string): Promise<RuntimeFleetReconciliationRun | null>;
  list(filter?: RuntimeFleetReconciliationFilter): Promise<readonly RuntimeFleetReconciliationRun[]>;
  create(run: RuntimeFleetReconciliationRun): Promise<RuntimeFleetReconciliationRun>;
}

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryRuntimeFleetReconciliationStore implements RuntimeFleetReconciliationStore {
  readonly #records = new Map<string, RuntimeFleetReconciliationRun>();

  async get(runId: string): Promise<RuntimeFleetReconciliationRun | null> {
    const record = this.#records.get(runId);
    return record ? clone(record) : null;
  }

  async list(filter: RuntimeFleetReconciliationFilter = {}): Promise<readonly RuntimeFleetReconciliationRun[]> {
    return [...this.#records.values()]
      .filter((record) => filter.outcome === undefined || record.outcome === filter.outcome)
      .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt) || left.runId.localeCompare(right.runId))
      .map(clone);
  }

  async create(run: RuntimeFleetReconciliationRun): Promise<RuntimeFleetReconciliationRun> {
    validateRuntimeFleetReconciliationRun(run);
    if (this.#records.has(run.runId)) {
      throw new ConcurrencyError(`Runtime fleet reconciliation '${run.runId}' already exists.`);
    }
    this.#records.set(run.runId, clone(run));
    return clone(run);
  }
}

export interface RuntimeFleetReconciliationRequest {
  readonly runId: string;
  /** Omit to reconcile every registered runtime. */
  readonly runtimeIds?: readonly string[];
}

export type RuntimeFleetReconciliationClock = () => Date;

/**
 * Compare M31 desired state with its latest trusted observation. This is a pure
 * planning/projection layer: it never changes runtime targets or starts control,
 * deployment or remediation work.
 */
export class RuntimeFleetReconciliationCatalog {
  constructor(
    private readonly targets: RuntimeTargetStore,
    private readonly runs: RuntimeFleetReconciliationStore,
    private readonly clock: RuntimeFleetReconciliationClock = () => new Date(),
  ) {}

  async reconcile(request: RuntimeFleetReconciliationRequest): Promise<RuntimeFleetReconciliationRun> {
    assertIdentity(request.runId, "runId");
    if (await this.runs.get(request.runId)) {
      throw new ConcurrencyError(`Runtime fleet reconciliation '${request.runId}' already exists.`);
    }

    const records = await this.resolveTargets(request.runtimeIds);
    const reconciled = records
      .map(reconcileTarget)
      .sort((left, right) => left.runtimeId.localeCompare(right.runtimeId));

    const compliant = reconciled.filter((target) => target.compliance === "compliant").length;
    const retired = reconciled.filter((target) => target.compliance === "retired").length;
    const reviewRequired = reconciled.filter((target) => target.recommendedAction === "review").length;
    const actionRequired = reconciled.filter(
      (target) => target.recommendedAction !== "none" && target.recommendedAction !== "review",
    ).length;
    const outcome: RuntimeFleetReconciliationOutcome = reviewRequired > 0
      ? "review-required"
      : actionRequired > 0
        ? "action-required"
        : "compliant";

    return this.runs.create({
      format: "nublox-metaobject-runtime-fleet-reconciliation",
      formatVersion: 1,
      runId: request.runId,
      outcome,
      targets: reconciled,
      total: reconciled.length,
      compliant,
      actionRequired,
      reviewRequired,
      retired,
      capturedAt: this.clock().toISOString(),
    });
  }

  async get(runId: string): Promise<RuntimeFleetReconciliationRun | null> {
    assertIdentity(runId, "runId");
    return this.runs.get(runId);
  }

  async history(filter: RuntimeFleetReconciliationFilter = {}): Promise<readonly RuntimeFleetReconciliationRun[]> {
    return this.runs.list(filter);
  }

  private async resolveTargets(runtimeIds?: readonly string[]): Promise<readonly RuntimeTargetRecord[]> {
    if (runtimeIds === undefined) return this.targets.list();

    const seen = new Set<string>();
    const records: RuntimeTargetRecord[] = [];
    for (const runtimeId of runtimeIds) {
      assertIdentity(runtimeId, "runtimeId");
      if (seen.has(runtimeId)) {
        throw new MetadataError(`Runtime fleet reconciliation contains duplicate runtime '${runtimeId}'.`);
      }
      seen.add(runtimeId);
      const record = await this.targets.get(runtimeId);
      if (!record) throw new MetadataError(`Unknown runtime target '${runtimeId}'.`);
      records.push(record);
    }
    return records;
  }
}

function observedProfile(observation: RuntimeTargetObservation): RuntimeTargetDesiredProfile {
  return { profileId: observation.profileId, profileVersion: observation.profileVersion };
}

function result(
  record: RuntimeTargetRecord,
  compliance: RuntimeFleetComplianceState,
  recommendedAction: RuntimeFleetRecommendedAction,
  reason: string,
): RuntimeFleetReconciliationTarget {
  return {
    runtimeId: record.runtimeId,
    targetRevision: record.revision,
    targetStatus: record.status,
    desiredProfile: clone(record.desiredProfile),
    ...(record.observation === undefined ? {} : {
      observedProfile: observedProfile(record.observation),
      postureState: record.observation.postureState,
    }),
    compliance,
    recommendedAction,
    reason,
  };
}

export function reconcileRuntimeTarget(record: RuntimeTargetRecord): RuntimeFleetReconciliationTarget {
  validateTargetForReconciliation(record);
  return reconcileTarget(record);
}

function reconcileTarget(record: RuntimeTargetRecord): RuntimeFleetReconciliationTarget {
  if (record.status === "retired") {
    return result(record, "retired", "none", "Runtime target is retired and excluded from desired-state convergence.");
  }

  const observation = record.observation;
  if (observation === undefined) {
    return result(record, "unobserved", "establish-observation", "Runtime has no trusted observed profile/posture yet.");
  }

  const desired = record.desiredProfile;
  if (observation.profileId !== desired.profileId) {
    return result(
      record,
      "profile-mismatch",
      "review",
      `Observed profile '${observation.profileId}@${observation.profileVersion}' differs from desired '${desired.profileId}@${desired.profileVersion}'.`,
    );
  }
  if (observation.profileVersion < desired.profileVersion) {
    return result(
      record,
      "profile-behind",
      "plan-profile-upgrade",
      `Observed profile version ${observation.profileVersion} is behind desired version ${desired.profileVersion}.`,
    );
  }
  if (observation.profileVersion > desired.profileVersion) {
    return result(
      record,
      "profile-ahead",
      "review",
      `Observed profile version ${observation.profileVersion} is ahead of desired version ${desired.profileVersion}; downgrade is not inferred automatically.`,
    );
  }

  switch (observation.postureState) {
    case "verified":
    case "restored":
      return result(record, "compliant", "none", "Observed profile matches desired profile and runtime posture is trusted.");
    case "warning":
      return result(record, "warning", "reassess", "Observed profile matches desired profile but runtime evidence is incomplete or unverifiable.");
    case "drifted":
      return result(record, "drifted", "plan-remediation", "Observed profile matches desired profile but runtime drift is present.");
    case "remediating":
      return result(record, "remediating", "wait-remediation", "A governed remediation case is already active for this runtime.");
    case "review":
      return result(record, "review", "review", "Runtime posture requires manual review.");
    case "stale":
      return result(record, "stale", "reassess", "Runtime evidence is stale and must be refreshed before convergence decisions continue.");
  }
}

function validateTargetForReconciliation(record: RuntimeTargetRecord): void {
  assertIdentity(record.runtimeId, "runtimeId");
  assertIdentity(record.desiredProfile.profileId, "desired profileId");
  assertPositiveVersion(record.desiredProfile.profileVersion, "desired profileVersion");
  if (!Number.isSafeInteger(record.revision) || record.revision < 1) {
    throw new MetadataError("Runtime fleet reconciliation target revision must be a positive integer.");
  }
}

function assertIdentity(value: string, label: string): void {
  if (!value.trim()) throw new MetadataError(`Runtime fleet reconciliation ${label} is required.`);
}

function assertPositiveVersion(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new MetadataError(`Runtime fleet reconciliation ${label} must be a positive integer.`);
  }
}

const validCompliance = new Set<RuntimeFleetComplianceState>([
  "compliant",
  "unobserved",
  "profile-behind",
  "profile-ahead",
  "profile-mismatch",
  "warning",
  "drifted",
  "remediating",
  "review",
  "stale",
  "retired",
]);
const validActions = new Set<RuntimeFleetRecommendedAction>([
  "none",
  "establish-observation",
  "plan-profile-upgrade",
  "reassess",
  "plan-remediation",
  "wait-remediation",
  "review",
]);
const validOutcomes = new Set<RuntimeFleetReconciliationOutcome>([
  "compliant",
  "action-required",
  "review-required",
]);

export function validateRuntimeFleetReconciliationRun(run: RuntimeFleetReconciliationRun): void {
  if (run.format !== "nublox-metaobject-runtime-fleet-reconciliation" || run.formatVersion !== 1) {
    throw new MetadataError("Unsupported runtime fleet reconciliation format.");
  }
  assertIdentity(run.runId, "runId");
  if (!validOutcomes.has(run.outcome)) {
    throw new MetadataError(`Invalid runtime fleet reconciliation outcome '${String(run.outcome)}'.`);
  }
  if (!run.capturedAt.trim()) throw new MetadataError("Runtime fleet reconciliation capturedAt is required.");
  if (run.total !== run.targets.length) {
    throw new MetadataError("Runtime fleet reconciliation total does not match target count.");
  }

  const runtimeIds = new Set<string>();
  for (const target of run.targets) {
    assertIdentity(target.runtimeId, "target runtimeId");
    if (runtimeIds.has(target.runtimeId)) {
      throw new MetadataError(`Runtime fleet reconciliation contains duplicate runtime '${target.runtimeId}'.`);
    }
    runtimeIds.add(target.runtimeId);
    if (!Number.isSafeInteger(target.targetRevision) || target.targetRevision < 1) {
      throw new MetadataError("Runtime fleet reconciliation targetRevision must be a positive integer.");
    }
    if (!validCompliance.has(target.compliance)) {
      throw new MetadataError(`Invalid runtime fleet compliance state '${String(target.compliance)}'.`);
    }
    if (!validActions.has(target.recommendedAction)) {
      throw new MetadataError(`Invalid runtime fleet recommended action '${String(target.recommendedAction)}'.`);
    }
    if (!target.reason.trim()) throw new MetadataError("Runtime fleet reconciliation reason is required.");
  }

  const expectedCompliant = run.targets.filter((target) => target.compliance === "compliant").length;
  const expectedRetired = run.targets.filter((target) => target.compliance === "retired").length;
  const expectedReview = run.targets.filter((target) => target.recommendedAction === "review").length;
  const expectedAction = run.targets.filter(
    (target) => target.recommendedAction !== "none" && target.recommendedAction !== "review",
  ).length;
  if (
    run.compliant !== expectedCompliant
    || run.retired !== expectedRetired
    || run.reviewRequired !== expectedReview
    || run.actionRequired !== expectedAction
  ) {
    throw new MetadataError("Runtime fleet reconciliation aggregate counts do not match target results.");
  }

  const expectedOutcome: RuntimeFleetReconciliationOutcome = expectedReview > 0
    ? "review-required"
    : expectedAction > 0
      ? "action-required"
      : "compliant";
  if (run.outcome !== expectedOutcome) {
    throw new MetadataError("Runtime fleet reconciliation outcome does not match target results.");
  }
}
