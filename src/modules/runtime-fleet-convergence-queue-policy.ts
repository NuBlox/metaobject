import { ConcurrencyError, MetadataError } from "../errors/errors.js";
import type {
  RuntimeFleetConvergenceAction,
  RuntimeFleetConvergenceCatalog,
  RuntimeFleetConvergenceWorkItem,
} from "./runtime-fleet-convergence.js";
import type {
  RuntimeFleetConvergenceExecutionRecord,
  RuntimeFleetConvergenceExecutionStore,
} from "./runtime-fleet-convergence-execution.js";

export type RuntimeFleetConvergenceQueueDecisionStatus = "eligible" | "blocked";
export type RuntimeFleetConvergenceQueueBlockReason =
  | "action-concurrency"
  | "runtime-exclusive"
  | "cooldown"
  | "attempts-exhausted"
  | "dependency"
  | "eligibility-rule";

export interface RuntimeFleetConvergenceQueuePolicyDefinition {
  readonly policyId: string;
  readonly version: number;
  /** Higher values are selected first. Unspecified actions default to zero. */
  readonly priorities?: Readonly<Partial<Record<RuntimeFleetConvergenceAction, number>>>;
  /** Maximum simultaneously in-progress/reserved work by action. */
  readonly maxConcurrentByAction?: Readonly<Partial<Record<RuntimeFleetConvergenceAction, number>>>;
  /** Only one in-progress/reserved work item per runtime when true. Defaults to true. */
  readonly runtimeExclusive?: boolean;
  /** Maximum M35 attempts before a pending retried item is blocked. */
  readonly defaultMaxAttempts?: number;
  readonly maxAttemptsByAction?: Readonly<Partial<Record<RuntimeFleetConvergenceAction, number>>>;
  /** Minimum delay after the latest terminal M35 attempt before another claim is eligible. */
  readonly defaultCooldownMs?: number;
  readonly cooldownMsByAction?: Readonly<Partial<Record<RuntimeFleetConvergenceAction, number>>>;
  /**
   * An action is blocked while any listed prerequisite action for the same runtime
   * has non-completed work. Absence of prerequisite work does not block it.
   */
  readonly dependencies?: Readonly<Partial<Record<RuntimeFleetConvergenceAction, readonly RuntimeFleetConvergenceAction[]>>>;
  /** Ordered named eligibility rules evaluated after built-in safety gates. */
  readonly eligibilityRules?: readonly string[];
}

export interface RuntimeFleetConvergenceQueueDecision {
  readonly workId: string;
  readonly runtimeId: string;
  readonly action: RuntimeFleetConvergenceAction;
  readonly workRevision: number;
  readonly priority: number;
  readonly status: RuntimeFleetConvergenceQueueDecisionStatus;
  readonly blockReasons: readonly RuntimeFleetConvergenceQueueBlockReason[];
  readonly details: readonly string[];
}

export interface RuntimeFleetConvergenceQueueEvaluation {
  readonly format: "nublox-metaobject-runtime-fleet-convergence-queue-evaluation";
  readonly formatVersion: 1;
  readonly evaluationId: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly decisions: readonly RuntimeFleetConvergenceQueueDecision[];
  readonly eligibleWorkIds: readonly string[];
  readonly total: number;
  readonly eligible: number;
  readonly blocked: number;
  readonly evaluatedAt: string;
}

export interface RuntimeFleetConvergenceQueueEvaluationFilter {
  readonly policyId?: string;
}

export interface RuntimeFleetConvergenceQueueEvaluationStore {
  get(evaluationId: string): Promise<RuntimeFleetConvergenceQueueEvaluation | null>;
  list(filter?: RuntimeFleetConvergenceQueueEvaluationFilter): Promise<readonly RuntimeFleetConvergenceQueueEvaluation[]>;
  create(evaluation: RuntimeFleetConvergenceQueueEvaluation): Promise<RuntimeFleetConvergenceQueueEvaluation>;
}

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryRuntimeFleetConvergenceQueueEvaluationStore implements RuntimeFleetConvergenceQueueEvaluationStore {
  readonly #records = new Map<string, RuntimeFleetConvergenceQueueEvaluation>();

  async get(evaluationId: string): Promise<RuntimeFleetConvergenceQueueEvaluation | null> {
    const record = this.#records.get(evaluationId);
    return record ? clone(record) : null;
  }

  async list(filter: RuntimeFleetConvergenceQueueEvaluationFilter = {}): Promise<readonly RuntimeFleetConvergenceQueueEvaluation[]> {
    return [...this.#records.values()]
      .filter((record) => filter.policyId === undefined || record.policyId === filter.policyId)
      .sort((left, right) => left.evaluatedAt.localeCompare(right.evaluatedAt) || left.evaluationId.localeCompare(right.evaluationId))
      .map(clone);
  }

  async create(evaluation: RuntimeFleetConvergenceQueueEvaluation): Promise<RuntimeFleetConvergenceQueueEvaluation> {
    validateRuntimeFleetConvergenceQueueEvaluation(evaluation);
    if (this.#records.has(evaluation.evaluationId)) {
      throw new ConcurrencyError(`Runtime fleet convergence queue evaluation '${evaluation.evaluationId}' already exists.`);
    }
    this.#records.set(evaluation.evaluationId, clone(evaluation));
    return clone(evaluation);
  }
}

export interface RuntimeFleetConvergenceEligibilityContext {
  readonly work: RuntimeFleetConvergenceWorkItem;
  readonly attempts: readonly RuntimeFleetConvergenceExecutionRecord[];
  readonly allWork: readonly RuntimeFleetConvergenceWorkItem[];
  readonly evaluatedAt: string;
}

export type RuntimeFleetConvergenceEligibilityRuleResult =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: string };

export interface RuntimeFleetConvergenceEligibilityRule {
  readonly id: string;
  evaluate(
    context: RuntimeFleetConvergenceEligibilityContext,
  ): Promise<RuntimeFleetConvergenceEligibilityRuleResult> | RuntimeFleetConvergenceEligibilityRuleResult;
}

export class RuntimeFleetConvergenceEligibilityRuleRegistry {
  readonly #rules = new Map<string, RuntimeFleetConvergenceEligibilityRule>();

  register(rule: RuntimeFleetConvergenceEligibilityRule): this {
    assertText(rule.id, "eligibility rule id");
    if (this.#rules.has(rule.id)) {
      throw new MetadataError(`Runtime fleet convergence eligibility rule '${rule.id}' is already registered.`);
    }
    this.#rules.set(rule.id, rule);
    return this;
  }

  get(id: string): RuntimeFleetConvergenceEligibilityRule | null {
    return this.#rules.get(id) ?? null;
  }
}

export interface RuntimeFleetConvergenceQueueEvaluationRequest {
  readonly evaluationId: string;
  readonly policy: RuntimeFleetConvergenceQueuePolicyDefinition;
  /** Omit to evaluate every pending work item. */
  readonly workIds?: readonly string[];
}

export type RuntimeFleetConvergenceQueueClock = () => Date;

/**
 * Deterministic advisory backpressure planner over M34/M35 state. The planner
 * never claims work or invokes executors; callers may pass eligibleWorkIds into
 * M36 as an explicit dispatch selection.
 */
export class RuntimeFleetConvergenceQueuePolicyCatalog {
  constructor(
    private readonly convergence: RuntimeFleetConvergenceCatalog,
    private readonly executions: RuntimeFleetConvergenceExecutionStore,
    private readonly rules: RuntimeFleetConvergenceEligibilityRuleRegistry,
    private readonly evaluations: RuntimeFleetConvergenceQueueEvaluationStore,
    private readonly clock: RuntimeFleetConvergenceQueueClock = () => new Date(),
  ) {}

  async evaluate(request: RuntimeFleetConvergenceQueueEvaluationRequest): Promise<RuntimeFleetConvergenceQueueEvaluation> {
    assertText(request.evaluationId, "evaluationId");
    validateRuntimeFleetConvergenceQueuePolicy(request.policy);
    if (await this.evaluations.get(request.evaluationId)) {
      throw new ConcurrencyError(`Runtime fleet convergence queue evaluation '${request.evaluationId}' already exists.`);
    }

    const evaluatedAt = this.clock().toISOString();
    const evaluatedAtMs = Date.parse(evaluatedAt);
    const allWork = [...await this.convergence.list()];
    const pending = await this.resolvePending(request.workIds, allWork);
    const active = allWork.filter((item) => item.status === "in-progress");
    const activeByAction = countByAction(active);
    const activeRuntimes = new Set(active.map((item) => item.runtimeId));
    const reservedByAction = new Map<RuntimeFleetConvergenceAction, number>();
    const reservedRuntimes = new Set<string>();

    const candidates = await Promise.all(pending.map(async (work) => ({
      work,
      attempts: [...await this.executions.list(work.workId)],
      priority: priorityFor(request.policy, work.action),
    })));
    candidates.sort((left, right) =>
      right.priority - left.priority
      || left.work.createdAt.localeCompare(right.work.createdAt)
      || left.work.workId.localeCompare(right.work.workId));

    const decisions: RuntimeFleetConvergenceQueueDecision[] = [];
    for (const candidate of candidates) {
      const reasons: RuntimeFleetConvergenceQueueBlockReason[] = [];
      const details: string[] = [];
      const { work, attempts } = candidate;

      const maxAttempts = numberForAction(
        request.policy.maxAttemptsByAction,
        work.action,
        request.policy.defaultMaxAttempts,
      );
      if (maxAttempts !== undefined && attempts.length >= maxAttempts) {
        reasons.push("attempts-exhausted");
        details.push(`Attempt limit ${maxAttempts} reached (${attempts.length} recorded).`);
      }

      const cooldownMs = numberForAction(
        request.policy.cooldownMsByAction,
        work.action,
        request.policy.defaultCooldownMs,
      );
      const latestFinishedAt = latestTerminalTimestamp(attempts);
      if (cooldownMs !== undefined && cooldownMs > 0 && latestFinishedAt !== undefined) {
        const nextEligibleAt = Date.parse(latestFinishedAt) + cooldownMs;
        if (Number.isFinite(nextEligibleAt) && evaluatedAtMs < nextEligibleAt) {
          reasons.push("cooldown");
          details.push(`Cooldown active until ${new Date(nextEligibleAt).toISOString()}.`);
        }
      }

      const dependencies = request.policy.dependencies?.[work.action] ?? [];
      const blockingDependencies = allWork.filter((item) =>
        item.runtimeId === work.runtimeId
        && dependencies.includes(item.action)
        && item.status !== "completed"
        && item.status !== "cancelled");
      if (blockingDependencies.length > 0) {
        reasons.push("dependency");
        details.push(`Blocked by ${blockingDependencies.map((item) => `${item.action}:${item.workId}`).join(", ")}.`);
      }

      if ((request.policy.runtimeExclusive ?? true) && (activeRuntimes.has(work.runtimeId) || reservedRuntimes.has(work.runtimeId))) {
        reasons.push("runtime-exclusive");
        details.push(`Runtime '${work.runtimeId}' already has active or reserved convergence work.`);
      }

      const actionLimit = request.policy.maxConcurrentByAction?.[work.action];
      if (actionLimit !== undefined) {
        const used = (activeByAction.get(work.action) ?? 0) + (reservedByAction.get(work.action) ?? 0);
        if (used >= actionLimit) {
          reasons.push("action-concurrency");
          details.push(`Action '${work.action}' concurrency limit ${actionLimit} is saturated (${used} active/reserved).`);
        }
      }

      for (const ruleId of request.policy.eligibilityRules ?? []) {
        const rule = this.rules.get(ruleId);
        if (!rule) throw new MetadataError(`Unknown runtime fleet convergence eligibility rule '${ruleId}'.`);
        let result: RuntimeFleetConvergenceEligibilityRuleResult;
        try {
          result = await rule.evaluate({
            work: clone(work),
            attempts: clone(attempts),
            allWork: clone(allWork),
            evaluatedAt,
          });
        } catch (error) {
          reasons.push("eligibility-rule");
          details.push(`Eligibility rule '${ruleId}' failed closed: ${errorMessage(error)}`);
          continue;
        }
        if (!result.eligible) {
          assertText(result.reason, `eligibility rule '${ruleId}' reason`);
          reasons.push("eligibility-rule");
          details.push(`Eligibility rule '${ruleId}' blocked work: ${result.reason}`);
        }
      }

      const status: RuntimeFleetConvergenceQueueDecisionStatus = reasons.length === 0 ? "eligible" : "blocked";
      if (status === "eligible") {
        reservedByAction.set(work.action, (reservedByAction.get(work.action) ?? 0) + 1);
        if (request.policy.runtimeExclusive ?? true) reservedRuntimes.add(work.runtimeId);
      }
      decisions.push({
        workId: work.workId,
        runtimeId: work.runtimeId,
        action: work.action,
        workRevision: work.revision,
        priority: candidate.priority,
        status,
        blockReasons: [...new Set(reasons)],
        details,
      });
    }

    const eligibleWorkIds = decisions.filter((decision) => decision.status === "eligible").map((decision) => decision.workId);
    return this.evaluations.create({
      format: "nublox-metaobject-runtime-fleet-convergence-queue-evaluation",
      formatVersion: 1,
      evaluationId: request.evaluationId,
      policyId: request.policy.policyId,
      policyVersion: request.policy.version,
      decisions,
      eligibleWorkIds,
      total: decisions.length,
      eligible: eligibleWorkIds.length,
      blocked: decisions.length - eligibleWorkIds.length,
      evaluatedAt,
    });
  }

  async get(evaluationId: string): Promise<RuntimeFleetConvergenceQueueEvaluation | null> {
    assertText(evaluationId, "evaluationId");
    return this.evaluations.get(evaluationId);
  }

  async history(filter: RuntimeFleetConvergenceQueueEvaluationFilter = {}): Promise<readonly RuntimeFleetConvergenceQueueEvaluation[]> {
    return this.evaluations.list(filter);
  }

  private async resolvePending(
    workIds: readonly string[] | undefined,
    allWork: readonly RuntimeFleetConvergenceWorkItem[],
  ): Promise<readonly RuntimeFleetConvergenceWorkItem[]> {
    if (workIds === undefined) return allWork.filter((item) => item.status === "pending");
    const byId = new Map(allWork.map((item) => [item.workId, item] as const));
    const seen = new Set<string>();
    const selected: RuntimeFleetConvergenceWorkItem[] = [];
    for (const workId of workIds) {
      assertText(workId, "workId");
      if (seen.has(workId)) throw new MetadataError(`Runtime fleet convergence queue evaluation contains duplicate work '${workId}'.`);
      seen.add(workId);
      const item = byId.get(workId);
      if (!item) throw new MetadataError(`Unknown runtime fleet convergence work '${workId}'.`);
      if (item.status !== "pending") {
        throw new MetadataError(`Runtime fleet convergence work '${workId}' is '${item.status}' and is not queue-eligible.`);
      }
      selected.push(item);
    }
    return selected;
  }
}

function priorityFor(policy: RuntimeFleetConvergenceQueuePolicyDefinition, action: RuntimeFleetConvergenceAction): number {
  return policy.priorities?.[action] ?? 0;
}

function numberForAction(
  values: Readonly<Partial<Record<RuntimeFleetConvergenceAction, number>>> | undefined,
  action: RuntimeFleetConvergenceAction,
  fallback: number | undefined,
): number | undefined {
  return values?.[action] ?? fallback;
}

function countByAction(items: readonly RuntimeFleetConvergenceWorkItem[]): Map<RuntimeFleetConvergenceAction, number> {
  const counts = new Map<RuntimeFleetConvergenceAction, number>();
  for (const item of items) counts.set(item.action, (counts.get(item.action) ?? 0) + 1);
  return counts;
}

function latestTerminalTimestamp(attempts: readonly RuntimeFleetConvergenceExecutionRecord[]): string | undefined {
  return attempts
    .filter((attempt) => attempt.finishedAt !== undefined)
    .map((attempt) => attempt.finishedAt!)
    .sort()
    .at(-1);
}

function assertText(value: string, label: string): void {
  if (!value.trim()) throw new MetadataError(`Runtime fleet convergence queue ${label} is required.`);
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MetadataError(`Runtime fleet convergence queue ${label} must be a non-negative integer.`);
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "unknown error";
}

const queueActions: readonly RuntimeFleetConvergenceAction[] = [
  "establish-observation",
  "plan-profile-upgrade",
  "reassess",
  "plan-remediation",
  "wait-remediation",
  "review",
];

export function validateRuntimeFleetConvergenceQueuePolicy(policy: RuntimeFleetConvergenceQueuePolicyDefinition): void {
  assertText(policy.policyId, "policyId");
  if (!Number.isSafeInteger(policy.version) || policy.version < 1) {
    throw new MetadataError("Runtime fleet convergence queue policy version must be a positive integer.");
  }
  for (const [label, values] of [
    ["priorities", policy.priorities],
    ["maxConcurrentByAction", policy.maxConcurrentByAction],
    ["maxAttemptsByAction", policy.maxAttemptsByAction],
    ["cooldownMsByAction", policy.cooldownMsByAction],
  ] as const) {
    if (!values) continue;
    for (const [action, value] of Object.entries(values)) {
      if (!queueActions.includes(action as RuntimeFleetConvergenceAction)) {
        throw new MetadataError(`Runtime fleet convergence queue ${label} contains unknown action '${action}'.`);
      }
      if (label === "priorities") {
        if (!Number.isSafeInteger(value)) throw new MetadataError("Runtime fleet convergence queue priorities must be safe integers.");
      } else {
        assertNonNegativeInteger(value, `${label}.${action}`);
      }
    }
  }
  if (policy.defaultMaxAttempts !== undefined) assertNonNegativeInteger(policy.defaultMaxAttempts, "defaultMaxAttempts");
  if (policy.defaultCooldownMs !== undefined) assertNonNegativeInteger(policy.defaultCooldownMs, "defaultCooldownMs");

  for (const [action, dependencies] of Object.entries(policy.dependencies ?? {})) {
    if (!queueActions.includes(action as RuntimeFleetConvergenceAction)) {
      throw new MetadataError(`Runtime fleet convergence queue dependencies contain unknown action '${action}'.`);
    }
    const seen = new Set<string>();
    for (const dependency of dependencies ?? []) {
      if (!queueActions.includes(dependency)) {
        throw new MetadataError(`Runtime fleet convergence queue dependency contains unknown action '${dependency}'.`);
      }
      if (dependency === action) throw new MetadataError(`Runtime fleet convergence queue action '${action}' cannot depend on itself.`);
      if (seen.has(dependency)) throw new MetadataError(`Runtime fleet convergence queue action '${action}' contains duplicate dependency '${dependency}'.`);
      seen.add(dependency);
    }
  }
  const rules = policy.eligibilityRules ?? [];
  if (new Set(rules).size !== rules.length) throw new MetadataError("Runtime fleet convergence queue policy contains duplicate eligibility rules.");
  for (const rule of rules) assertText(rule, "eligibility rule id");
}

export function validateRuntimeFleetConvergenceQueueEvaluation(evaluation: RuntimeFleetConvergenceQueueEvaluation): void {
  if (evaluation.format !== "nublox-metaobject-runtime-fleet-convergence-queue-evaluation" || evaluation.formatVersion !== 1) {
    throw new MetadataError("Unsupported runtime fleet convergence queue evaluation format.");
  }
  assertText(evaluation.evaluationId, "evaluationId");
  assertText(evaluation.policyId, "policyId");
  assertText(evaluation.evaluatedAt, "evaluatedAt");
  if (!Number.isSafeInteger(evaluation.policyVersion) || evaluation.policyVersion < 1) {
    throw new MetadataError("Runtime fleet convergence queue policyVersion must be a positive integer.");
  }
  for (const value of [evaluation.total, evaluation.eligible, evaluation.blocked]) assertNonNegativeInteger(value, "counter");
  if (evaluation.total !== evaluation.decisions.length || evaluation.total !== evaluation.eligible + evaluation.blocked) {
    throw new MetadataError("Runtime fleet convergence queue evaluation counters do not match decisions.");
  }
  const ids = new Set<string>();
  for (const decision of evaluation.decisions) {
    assertText(decision.workId, "decision workId");
    assertText(decision.runtimeId, "decision runtimeId");
    if (ids.has(decision.workId)) throw new MetadataError(`Runtime fleet convergence queue evaluation contains duplicate work '${decision.workId}'.`);
    ids.add(decision.workId);
    if (!Number.isSafeInteger(decision.workRevision) || decision.workRevision < 1) {
      throw new MetadataError("Runtime fleet convergence queue decision workRevision must be a positive integer.");
    }
    if (!Number.isSafeInteger(decision.priority)) throw new MetadataError("Runtime fleet convergence queue decision priority must be a safe integer.");
    if (decision.status === "eligible") {
      if (decision.blockReasons.length > 0 || decision.details.length > 0) {
        throw new MetadataError("Eligible runtime fleet convergence queue decision cannot contain block reasons/details.");
      }
    } else if (decision.status === "blocked") {
      if (decision.blockReasons.length === 0 || decision.details.length === 0) {
        throw new MetadataError("Blocked runtime fleet convergence queue decision requires reasons/details.");
      }
    } else {
      throw new MetadataError(`Invalid runtime fleet convergence queue decision status '${String(decision.status)}'.`);
    }
  }
  const eligibleIds = evaluation.decisions.filter((decision) => decision.status === "eligible").map((decision) => decision.workId);
  if (eligibleIds.length !== evaluation.eligibleWorkIds.length || eligibleIds.some((id, index) => id !== evaluation.eligibleWorkIds[index])) {
    throw new MetadataError("Runtime fleet convergence queue eligibleWorkIds do not match eligible decisions.");
  }
}
