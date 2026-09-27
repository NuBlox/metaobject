import { ConcurrencyError, MetadataError } from "../errors/errors.js";
import type {
  RuntimeFleetConvergenceDispatchRun,
  RuntimeFleetConvergenceDispatchStore,
} from "./runtime-fleet-convergence-dispatch.js";
import type {
  RuntimeFleetConvergenceQueueDecision,
  RuntimeFleetConvergenceQueueEvaluation,
  RuntimeFleetConvergenceQueueEvaluationStore,
} from "./runtime-fleet-convergence-queue-policy.js";
import { validateRuntimeFleetConvergenceQueueEvaluation } from "./runtime-fleet-convergence-queue-policy.js";
import type {
  RuntimeFleetConvergenceAction,
  RuntimeFleetConvergenceCatalog,
  RuntimeFleetConvergenceWorkItem,
} from "./runtime-fleet-convergence.js";

export interface RuntimeFleetConvergenceFairnessPolicyDefinition {
  readonly policyId: string;
  readonly version: number;
  /** Queue age before age boosting begins. Defaults to zero when boosting is configured. */
  readonly ageBoostAfterMs?: number;
  /** Queue-age interval that earns another boost step. Omit to disable age boosting. */
  readonly ageBoostStepMs?: number;
  /** Priority points awarded for each completed age step. Defaults to one. */
  readonly ageBoostPerStep?: number;
  /** Optional cap on total queue-age priority boost. */
  readonly maxAgeBoost?: number;
  /** Work at or above this queue age is promoted ahead of non-starved work. */
  readonly starvationThresholdMs?: number;
  /** Number of most recent M36 dispatches considered when measuring recent service. Defaults to 20. */
  readonly historyDispatches?: number;
  /** Priority penalty per recently dispatched item for the same runtime. Defaults to zero. */
  readonly runtimeHistoryPenalty?: number;
  /** Priority penalty per recently dispatched item for the same action. Defaults to zero. */
  readonly actionHistoryPenalty?: number;
  /** Soft cap on consecutive selections for one runtime inside one fairness ordering. */
  readonly maxConsecutivePerRuntime?: number;
  /** Soft cap on consecutive selections for one action inside one fairness ordering. */
  readonly maxConsecutivePerAction?: number;
}

export interface RuntimeFleetConvergenceFairnessDecision {
  readonly workId: string;
  readonly runtimeId: string;
  readonly action: RuntimeFleetConvergenceAction;
  readonly workRevision: number;
  readonly basePriority: number;
  readonly ageMs: number;
  readonly ageBoost: number;
  readonly recentRuntimeSelections: number;
  readonly recentActionSelections: number;
  readonly runtimePenalty: number;
  readonly actionPenalty: number;
  readonly effectivePriority: number;
  readonly starved: boolean;
  readonly rank: number;
}

export interface RuntimeFleetConvergenceFairnessEvaluation {
  readonly format: "nublox-metaobject-runtime-fleet-convergence-fairness";
  readonly formatVersion: 1;
  readonly fairnessId: string;
  readonly sourceEvaluationId: string;
  readonly sourcePolicyId: string;
  readonly sourcePolicyVersion: number;
  readonly fairnessPolicyId: string;
  readonly fairnessPolicyVersion: number;
  readonly historyDispatchIds: readonly string[];
  readonly decisions: readonly RuntimeFleetConvergenceFairnessDecision[];
  readonly orderedWorkIds: readonly string[];
  readonly starvedWorkIds: readonly string[];
  readonly total: number;
  readonly evaluatedAt: string;
}

export interface RuntimeFleetConvergenceFairnessFilter {
  readonly fairnessPolicyId?: string;
  readonly sourcePolicyId?: string;
}

export interface RuntimeFleetConvergenceFairnessStore {
  get(fairnessId: string): Promise<RuntimeFleetConvergenceFairnessEvaluation | null>;
  list(filter?: RuntimeFleetConvergenceFairnessFilter): Promise<readonly RuntimeFleetConvergenceFairnessEvaluation[]>;
  create(evaluation: RuntimeFleetConvergenceFairnessEvaluation): Promise<RuntimeFleetConvergenceFairnessEvaluation>;
}

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryRuntimeFleetConvergenceFairnessStore implements RuntimeFleetConvergenceFairnessStore {
  readonly #records = new Map<string, RuntimeFleetConvergenceFairnessEvaluation>();

  async get(fairnessId: string): Promise<RuntimeFleetConvergenceFairnessEvaluation | null> {
    const record = this.#records.get(fairnessId);
    return record ? clone(record) : null;
  }

  async list(filter: RuntimeFleetConvergenceFairnessFilter = {}): Promise<readonly RuntimeFleetConvergenceFairnessEvaluation[]> {
    return [...this.#records.values()]
      .filter((record) => filter.fairnessPolicyId === undefined || record.fairnessPolicyId === filter.fairnessPolicyId)
      .filter((record) => filter.sourcePolicyId === undefined || record.sourcePolicyId === filter.sourcePolicyId)
      .sort((left, right) => left.evaluatedAt.localeCompare(right.evaluatedAt) || left.fairnessId.localeCompare(right.fairnessId))
      .map(clone);
  }

  async create(evaluation: RuntimeFleetConvergenceFairnessEvaluation): Promise<RuntimeFleetConvergenceFairnessEvaluation> {
    validateRuntimeFleetConvergenceFairnessEvaluation(evaluation);
    if (this.#records.has(evaluation.fairnessId)) {
      throw new ConcurrencyError(`Runtime fleet convergence fairness evaluation '${evaluation.fairnessId}' already exists.`);
    }
    this.#records.set(evaluation.fairnessId, clone(evaluation));
    return clone(evaluation);
  }
}

export interface RuntimeFleetConvergenceFairnessRequest {
  readonly fairnessId: string;
  readonly sourceEvaluationId: string;
  readonly policy: RuntimeFleetConvergenceFairnessPolicyDefinition;
}

export interface RuntimeFleetConvergenceQueueEvaluationSource {
  get(evaluationId: string): Promise<RuntimeFleetConvergenceQueueEvaluation | null>;
}

export type RuntimeFleetConvergenceFairnessClock = () => Date;

interface Candidate {
  readonly work: RuntimeFleetConvergenceWorkItem;
  readonly sourceDecision: RuntimeFleetConvergenceQueueDecision;
  readonly basePriority: number;
  readonly ageMs: number;
  readonly ageBoost: number;
  readonly recentRuntimeSelections: number;
  readonly recentActionSelections: number;
  readonly runtimePenalty: number;
  readonly actionPenalty: number;
  readonly effectivePriority: number;
  readonly starved: boolean;
}

/**
 * Deterministic fairness overlay for M37. M39 never promotes blocked work into
 * eligibility; it only orders the exact M37 eligible set and records why each
 * item received its rank. M38 remains the final stale-revision admission gate.
 */
export class RuntimeFleetConvergenceFairnessCatalog {
  constructor(
    private readonly queueEvaluations: RuntimeFleetConvergenceQueueEvaluationSource,
    private readonly convergence: RuntimeFleetConvergenceCatalog,
    private readonly dispatches: RuntimeFleetConvergenceDispatchStore,
    private readonly evaluations: RuntimeFleetConvergenceFairnessStore,
    private readonly clock: RuntimeFleetConvergenceFairnessClock = () => new Date(),
  ) {}

  async evaluate(request: RuntimeFleetConvergenceFairnessRequest): Promise<RuntimeFleetConvergenceFairnessEvaluation> {
    assertText(request.fairnessId, "fairnessId");
    assertText(request.sourceEvaluationId, "sourceEvaluationId");
    validateRuntimeFleetConvergenceFairnessPolicy(request.policy);
    if (await this.evaluations.get(request.fairnessId)) {
      throw new ConcurrencyError(`Runtime fleet convergence fairness evaluation '${request.fairnessId}' already exists.`);
    }

    const source = await this.queueEvaluations.get(request.sourceEvaluationId);
    if (!source) throw new MetadataError(`Unknown runtime fleet convergence queue evaluation '${request.sourceEvaluationId}'.`);
    validateRuntimeFleetConvergenceQueueEvaluation(source);

    const evaluatedAt = this.clock().toISOString();
    const evaluatedAtMs = Date.parse(evaluatedAt);
    if (!Number.isFinite(evaluatedAtMs)) throw new MetadataError("Runtime fleet convergence fairness clock returned an invalid date.");

    const recentDispatches = await this.recentDispatches(request.policy);
    const runtimeSelections = countRecentRuntimeSelections(recentDispatches);
    const actionSelections = countRecentActionSelections(recentDispatches);
    const sourceById = new Map(source.decisions.map((decision) => [decision.workId, decision] as const));

    const candidates: Candidate[] = [];
    for (const workId of source.eligibleWorkIds) {
      const decision = sourceById.get(workId);
      if (!decision || decision.status !== "eligible") {
        throw new MetadataError(`Runtime fleet convergence fairness source '${source.evaluationId}' contains invalid eligible work '${workId}'.`);
      }
      const work = await this.convergence.get(workId);
      if (!work) throw new ConcurrencyError(`Runtime fleet convergence work '${workId}' no longer exists.`);
      this.assertExactSource(work, decision);

      const createdAtMs = Date.parse(work.createdAt);
      if (!Number.isFinite(createdAtMs)) {
        throw new MetadataError(`Runtime fleet convergence work '${workId}' has invalid createdAt '${work.createdAt}'.`);
      }
      const ageMs = Math.max(0, evaluatedAtMs - createdAtMs);
      const ageBoost = calculateAgeBoost(request.policy, ageMs);
      const recentRuntimeSelections = runtimeSelections.get(work.runtimeId) ?? 0;
      const recentActionSelections = actionSelections.get(work.action) ?? 0;
      const runtimePenalty = recentRuntimeSelections * (request.policy.runtimeHistoryPenalty ?? 0);
      const actionPenalty = recentActionSelections * (request.policy.actionHistoryPenalty ?? 0);
      const starved = request.policy.starvationThresholdMs !== undefined
        && ageMs >= request.policy.starvationThresholdMs;

      candidates.push({
        work,
        sourceDecision: decision,
        basePriority: decision.priority,
        ageMs,
        ageBoost,
        recentRuntimeSelections,
        recentActionSelections,
        runtimePenalty,
        actionPenalty,
        effectivePriority: decision.priority + ageBoost - runtimePenalty - actionPenalty,
        starved,
      });
    }

    candidates.sort(compareCandidates);
    const ordered = applyConsecutiveFairness(candidates, request.policy);
    const decisions = ordered.map((candidate, index): RuntimeFleetConvergenceFairnessDecision => ({
      workId: candidate.work.workId,
      runtimeId: candidate.work.runtimeId,
      action: candidate.work.action,
      workRevision: candidate.work.revision,
      basePriority: candidate.basePriority,
      ageMs: candidate.ageMs,
      ageBoost: candidate.ageBoost,
      recentRuntimeSelections: candidate.recentRuntimeSelections,
      recentActionSelections: candidate.recentActionSelections,
      runtimePenalty: candidate.runtimePenalty,
      actionPenalty: candidate.actionPenalty,
      effectivePriority: candidate.effectivePriority,
      starved: candidate.starved,
      rank: index + 1,
    }));

    return this.evaluations.create({
      format: "nublox-metaobject-runtime-fleet-convergence-fairness",
      formatVersion: 1,
      fairnessId: request.fairnessId,
      sourceEvaluationId: source.evaluationId,
      sourcePolicyId: source.policyId,
      sourcePolicyVersion: source.policyVersion,
      fairnessPolicyId: request.policy.policyId,
      fairnessPolicyVersion: request.policy.version,
      historyDispatchIds: recentDispatches.map((dispatch) => dispatch.dispatchId),
      decisions,
      orderedWorkIds: decisions.map((decision) => decision.workId),
      starvedWorkIds: decisions.filter((decision) => decision.starved).map((decision) => decision.workId),
      total: decisions.length,
      evaluatedAt,
    });
  }

  async get(fairnessId: string): Promise<RuntimeFleetConvergenceFairnessEvaluation | null> {
    assertText(fairnessId, "fairnessId");
    return this.evaluations.get(fairnessId);
  }

  async history(filter: RuntimeFleetConvergenceFairnessFilter = {}): Promise<readonly RuntimeFleetConvergenceFairnessEvaluation[]> {
    return this.evaluations.list(filter);
  }

  private async recentDispatches(policy: RuntimeFleetConvergenceFairnessPolicyDefinition): Promise<readonly RuntimeFleetConvergenceDispatchRun[]> {
    const limit = policy.historyDispatches ?? 20;
    if (limit === 0) return [];
    const history = [...await this.dispatches.list()];
    history.sort((left, right) => right.completedAt.localeCompare(left.completedAt) || right.dispatchId.localeCompare(left.dispatchId));
    return history.slice(0, limit);
  }

  private assertExactSource(work: RuntimeFleetConvergenceWorkItem, decision: RuntimeFleetConvergenceQueueDecision): void {
    if (work.status !== "pending") {
      throw new ConcurrencyError(`Runtime fleet convergence work '${work.workId}' is '${work.status}' and the M37 fairness source is stale.`);
    }
    if (work.revision !== decision.workRevision) {
      throw new ConcurrencyError(
        `Runtime fleet convergence work '${work.workId}' changed from evaluated revision ${decision.workRevision} to ${work.revision}.`,
      );
    }
    if (work.runtimeId !== decision.runtimeId || work.action !== decision.action) {
      throw new ConcurrencyError(`Runtime fleet convergence work '${work.workId}' identity changed after M37 evaluation.`);
    }
  }
}

function compareCandidates(left: Candidate, right: Candidate): number {
  if (left.starved !== right.starved) return left.starved ? -1 : 1;
  return right.effectivePriority - left.effectivePriority
    || left.recentRuntimeSelections - right.recentRuntimeSelections
    || left.recentActionSelections - right.recentActionSelections
    || right.ageMs - left.ageMs
    || left.work.createdAt.localeCompare(right.work.createdAt)
    || left.work.workId.localeCompare(right.work.workId);
}

function applyConsecutiveFairness(
  sorted: readonly Candidate[],
  policy: RuntimeFleetConvergenceFairnessPolicyDefinition,
): readonly Candidate[] {
  const remaining = [...sorted];
  const result: Candidate[] = [];
  let lastRuntime: string | undefined;
  let runtimeStreak = 0;
  let lastAction: RuntimeFleetConvergenceAction | undefined;
  let actionStreak = 0;

  while (remaining.length > 0) {
    let index = remaining.findIndex((candidate) => {
      const runtimeBlocked = policy.maxConsecutivePerRuntime !== undefined
        && candidate.work.runtimeId === lastRuntime
        && runtimeStreak >= policy.maxConsecutivePerRuntime;
      const actionBlocked = policy.maxConsecutivePerAction !== undefined
        && candidate.work.action === lastAction
        && actionStreak >= policy.maxConsecutivePerAction;
      return !runtimeBlocked && !actionBlocked;
    });
    if (index < 0) index = 0;
    const [chosen] = remaining.splice(index, 1);
    if (!chosen) throw new MetadataError("Runtime fleet convergence fairness ordering failed to select a candidate.");
    result.push(chosen);

    if (chosen.work.runtimeId === lastRuntime) runtimeStreak += 1;
    else {
      lastRuntime = chosen.work.runtimeId;
      runtimeStreak = 1;
    }
    if (chosen.work.action === lastAction) actionStreak += 1;
    else {
      lastAction = chosen.work.action;
      actionStreak = 1;
    }
  }

  return result;
}

function calculateAgeBoost(policy: RuntimeFleetConvergenceFairnessPolicyDefinition, ageMs: number): number {
  const stepMs = policy.ageBoostStepMs;
  if (stepMs === undefined) return 0;
  const afterMs = policy.ageBoostAfterMs ?? 0;
  if (ageMs < afterMs) return 0;
  const steps = Math.floor((ageMs - afterMs) / stepMs) + 1;
  const raw = steps * (policy.ageBoostPerStep ?? 1);
  return policy.maxAgeBoost === undefined ? raw : Math.min(raw, policy.maxAgeBoost);
}

function countRecentRuntimeSelections(dispatches: readonly RuntimeFleetConvergenceDispatchRun[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const dispatch of dispatches) {
    for (const item of dispatch.items) counts.set(item.runtimeId, (counts.get(item.runtimeId) ?? 0) + 1);
  }
  return counts;
}

function countRecentActionSelections(
  dispatches: readonly RuntimeFleetConvergenceDispatchRun[],
): Map<RuntimeFleetConvergenceAction, number> {
  const counts = new Map<RuntimeFleetConvergenceAction, number>();
  for (const dispatch of dispatches) {
    for (const item of dispatch.items) counts.set(item.action, (counts.get(item.action) ?? 0) + 1);
  }
  return counts;
}

function assertText(value: string, label: string): void {
  if (!value.trim()) throw new MetadataError(`Runtime fleet convergence fairness ${label} is required.`);
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MetadataError(`Runtime fleet convergence fairness ${label} must be a non-negative integer.`);
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new MetadataError(`Runtime fleet convergence fairness ${label} must be a positive integer.`);
  }
}

export function validateRuntimeFleetConvergenceFairnessPolicy(policy: RuntimeFleetConvergenceFairnessPolicyDefinition): void {
  assertText(policy.policyId, "policyId");
  assertPositiveInteger(policy.version, "policy version");
  for (const [label, value] of [
    ["ageBoostAfterMs", policy.ageBoostAfterMs],
    ["ageBoostPerStep", policy.ageBoostPerStep],
    ["maxAgeBoost", policy.maxAgeBoost],
    ["starvationThresholdMs", policy.starvationThresholdMs],
    ["historyDispatches", policy.historyDispatches],
    ["runtimeHistoryPenalty", policy.runtimeHistoryPenalty],
    ["actionHistoryPenalty", policy.actionHistoryPenalty],
  ] as const) {
    if (value !== undefined) assertNonNegativeInteger(value, label);
  }
  if (policy.ageBoostStepMs !== undefined) assertPositiveInteger(policy.ageBoostStepMs, "ageBoostStepMs");
  if (policy.maxConsecutivePerRuntime !== undefined) {
    assertPositiveInteger(policy.maxConsecutivePerRuntime, "maxConsecutivePerRuntime");
  }
  if (policy.maxConsecutivePerAction !== undefined) {
    assertPositiveInteger(policy.maxConsecutivePerAction, "maxConsecutivePerAction");
  }
  if ((policy.ageBoostAfterMs !== undefined || policy.ageBoostPerStep !== undefined || policy.maxAgeBoost !== undefined)
    && policy.ageBoostStepMs === undefined) {
    throw new MetadataError("Runtime fleet convergence fairness ageBoostStepMs is required when age boosting options are configured.");
  }
}

export function validateRuntimeFleetConvergenceFairnessEvaluation(
  evaluation: RuntimeFleetConvergenceFairnessEvaluation,
): void {
  if (evaluation.format !== "nublox-metaobject-runtime-fleet-convergence-fairness" || evaluation.formatVersion !== 1) {
    throw new MetadataError("Unsupported runtime fleet convergence fairness format.");
  }
  for (const [label, value] of Object.entries({
    fairnessId: evaluation.fairnessId,
    sourceEvaluationId: evaluation.sourceEvaluationId,
    sourcePolicyId: evaluation.sourcePolicyId,
    fairnessPolicyId: evaluation.fairnessPolicyId,
    evaluatedAt: evaluation.evaluatedAt,
  })) assertText(value, label);
  assertPositiveInteger(evaluation.sourcePolicyVersion, "sourcePolicyVersion");
  assertPositiveInteger(evaluation.fairnessPolicyVersion, "fairnessPolicyVersion");
  assertNonNegativeInteger(evaluation.total, "total");
  if (evaluation.total !== evaluation.decisions.length || evaluation.total !== evaluation.orderedWorkIds.length) {
    throw new MetadataError("Runtime fleet convergence fairness counters do not match decisions.");
  }
  const ids = new Set<string>();
  for (const [index, decision] of evaluation.decisions.entries()) {
    assertText(decision.workId, "decision workId");
    assertText(decision.runtimeId, "decision runtimeId");
    assertPositiveInteger(decision.workRevision, "decision workRevision");
    if (!Number.isFinite(decision.basePriority) || !Number.isFinite(decision.effectivePriority)) {
      throw new MetadataError("Runtime fleet convergence fairness priorities must be finite numbers.");
    }
    for (const value of [
      decision.ageMs,
      decision.ageBoost,
      decision.recentRuntimeSelections,
      decision.recentActionSelections,
      decision.runtimePenalty,
      decision.actionPenalty,
    ]) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new MetadataError("Runtime fleet convergence fairness metrics must be non-negative integers.");
      }
    }
    if (decision.rank !== index + 1) throw new MetadataError("Runtime fleet convergence fairness ranks must be contiguous.");
    if (ids.has(decision.workId)) throw new MetadataError(`Runtime fleet convergence fairness contains duplicate work '${decision.workId}'.`);
    ids.add(decision.workId);
    if (evaluation.orderedWorkIds[index] !== decision.workId) {
      throw new MetadataError("Runtime fleet convergence fairness orderedWorkIds do not match decision ranks.");
    }
  }
  const starved = new Set(evaluation.decisions.filter((decision) => decision.starved).map((decision) => decision.workId));
  if (starved.size !== evaluation.starvedWorkIds.length || evaluation.starvedWorkIds.some((workId) => !starved.has(workId))) {
    throw new MetadataError("Runtime fleet convergence fairness starvedWorkIds do not match decisions.");
  }
  const dispatchIds = new Set(evaluation.historyDispatchIds);
  if (dispatchIds.size !== evaluation.historyDispatchIds.length || evaluation.historyDispatchIds.some((id) => !id.trim())) {
    throw new MetadataError("Runtime fleet convergence fairness history dispatch IDs must be unique non-empty strings.");
  }
}
