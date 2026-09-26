import { MetadataError } from "../errors/errors.js";
import type { RuntimeDeploymentCatalog } from "./runtime-deployment-catalog.js";
import type {
  RuntimeDeploymentRecord,
  RuntimeDeploymentStepEvidence,
  RuntimeDeploymentStepState,
} from "./runtime-deployment-store.js";
import type {
  RuntimeProfileUpgradeStep,
  RuntimeProfileUpgradeStepKind,
} from "./runtime-profile-upgrade.js";

export type RuntimeDeploymentExecutorIdempotencyMode = "keyed" | "reconciled";

export interface RuntimeDeploymentExecutorEvidence {
  readonly externalReference?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type RuntimeDeploymentExecutorResult =
  | {
      readonly status: "completed";
      readonly evidence?: RuntimeDeploymentExecutorEvidence;
    }
  | {
      readonly status: "failed";
      readonly error: string;
      readonly evidence?: RuntimeDeploymentExecutorEvidence;
    };

export type RuntimeDeploymentReconciliationResult =
  | {
      readonly resolution: "completed";
      readonly evidence?: RuntimeDeploymentExecutorEvidence;
    }
  | { readonly resolution: "retry" }
  | { readonly resolution: "unknown" };

export interface RuntimeDeploymentExecutionContext {
  readonly deployment: RuntimeDeploymentRecord;
  readonly step: RuntimeProfileUpgradeStep;
  readonly state: RuntimeDeploymentStepState;
  readonly attempt: number;
  /** Stable across retries of one deployment step. */
  readonly idempotencyKey: string;
}

export interface RuntimeDeploymentStepExecutor {
  readonly id: string;
  readonly kinds: readonly RuntimeProfileUpgradeStepKind[];
  /**
   * keyed: execute() is safe to call repeatedly with the same idempotency key.
   * reconciled: reconcile() must determine whether an uncertain side effect
   * completed before the framework is allowed to retry it.
   */
  readonly idempotency: RuntimeDeploymentExecutorIdempotencyMode;
  execute(
    context: RuntimeDeploymentExecutionContext,
  ): Promise<RuntimeDeploymentExecutorResult> | RuntimeDeploymentExecutorResult;
  reconcile?(
    context: RuntimeDeploymentExecutionContext,
  ): Promise<RuntimeDeploymentReconciliationResult> | RuntimeDeploymentReconciliationResult;
}

export class RuntimeDeploymentExecutorRegistry {
  readonly #executorsById = new Map<string, RuntimeDeploymentStepExecutor>();
  readonly #executorsByKind = new Map<RuntimeProfileUpgradeStepKind, RuntimeDeploymentStepExecutor>();

  register(executor: RuntimeDeploymentStepExecutor): this {
    if (!executor.id.trim()) throw new MetadataError("Runtime deployment executor id is required.");
    if (executor.kinds.length === 0) {
      throw new MetadataError(`Runtime deployment executor '${executor.id}' must declare at least one step kind.`);
    }
    if (this.#executorsById.has(executor.id)) {
      throw new MetadataError(`Runtime deployment executor '${executor.id}' is already registered.`);
    }
    if (executor.idempotency === "reconciled" && !executor.reconcile) {
      throw new MetadataError(`Reconciled runtime deployment executor '${executor.id}' must implement reconcile().`);
    }

    const uniqueKinds = new Set<RuntimeProfileUpgradeStepKind>();
    for (const kind of executor.kinds) {
      if (uniqueKinds.has(kind)) {
        throw new MetadataError(`Runtime deployment executor '${executor.id}' declares duplicate step kind '${kind}'.`);
      }
      uniqueKinds.add(kind);
      const existing = this.#executorsByKind.get(kind);
      if (existing) {
        throw new MetadataError(
          `Runtime deployment step kind '${kind}' is already handled by executor '${existing.id}'.`,
        );
      }
    }

    this.#executorsById.set(executor.id, executor);
    for (const kind of uniqueKinds) this.#executorsByKind.set(kind, executor);
    return this;
  }

  get(kind: RuntimeProfileUpgradeStepKind): RuntimeDeploymentStepExecutor | null {
    return this.#executorsByKind.get(kind) ?? null;
  }

  getById(id: string): RuntimeDeploymentStepExecutor | null {
    return this.#executorsById.get(id) ?? null;
  }

  has(kind: RuntimeProfileUpgradeStepKind): boolean {
    return this.#executorsByKind.has(kind);
  }
}

export type RuntimeDeploymentRunBlockedReason =
  | "approval-required"
  | "not-started"
  | "recovery-required"
  | "step-failed"
  | "missing-executor"
  | "executor-mismatch"
  | "reconciliation-unknown"
  | "max-steps";

export interface RuntimeDeploymentRunResult {
  readonly record: RuntimeDeploymentRecord;
  readonly executedSteps: number;
  readonly blockedReason?: RuntimeDeploymentRunBlockedReason;
}

export interface RuntimeDeploymentRunOptions {
  /** Start a planned deployment automatically when approval requirements are satisfied. Defaults to true. */
  readonly autoStart?: boolean;
  /** Prevent one invocation from executing an unbounded number of external operations. Defaults to 100. */
  readonly maxSteps?: number;
}

export type RuntimeDeploymentExecutionClock = () => Date;
export type RuntimeDeploymentIdempotencyKeyFactory = (
  deploymentId: string,
  step: RuntimeProfileUpgradeStep,
) => string;

function defaultIdempotencyKey(deploymentId: string, step: RuntimeProfileUpgradeStep): string {
  return `${deploymentId}:${step.id}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "Runtime deployment executor failed with an unknown error.";
}

export class RuntimeDeploymentRunner {
  constructor(
    private readonly deployments: RuntimeDeploymentCatalog,
    private readonly executors: RuntimeDeploymentExecutorRegistry,
    private readonly clock: RuntimeDeploymentExecutionClock = () => new Date(),
    private readonly idempotencyKeys: RuntimeDeploymentIdempotencyKeyFactory = defaultIdempotencyKey,
  ) {}

  /** Execute pending work until the deployment completes, blocks or reaches maxSteps. */
  async run(deploymentId: string, options: RuntimeDeploymentRunOptions = {}): Promise<RuntimeDeploymentRunResult> {
    const autoStart = options.autoStart ?? true;
    const maxSteps = options.maxSteps ?? 100;
    if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) {
      throw new MetadataError("Runtime deployment runner maxSteps must be a positive integer.");
    }

    let record = await this.requireDeployment(deploymentId);
    let executedSteps = 0;

    if (record.status === "completed" || record.status === "cancelled") {
      return { record, executedSteps };
    }
    if (record.status === "failed") {
      return { record, executedSteps, blockedReason: "step-failed" };
    }

    if (record.status === "planned") {
      if (record.plan.requiresManualReview && !record.approvedAt) {
        return { record, executedSteps, blockedReason: "approval-required" };
      }
      if (!autoStart) return { record, executedSteps, blockedReason: "not-started" };
      record = await this.deployments.start(record.deploymentId, record.revision);
      if (record.status === "completed") return { record, executedSteps };
    }

    while (record.status === "running") {
      const unresolved = record.steps.find((state) => state.status === "running");
      if (unresolved) return { record, executedSteps, blockedReason: "recovery-required" };
      const failed = record.steps.find((state) => state.status === "failed");
      if (failed) return { record, executedSteps, blockedReason: "step-failed" };

      const pending = record.steps.find((state) => state.status === "pending");
      if (!pending) return { record, executedSteps };
      if (executedSteps >= maxSteps) return { record, executedSteps, blockedReason: "max-steps" };

      const step = this.requirePlanStep(record, pending.stepId);
      const executor = this.executors.get(step.kind);
      if (!executor) return { record, executedSteps, blockedReason: "missing-executor" };
      if (pending.executorId !== undefined && pending.executorId !== executor.id) {
        return { record, executedSteps, blockedReason: "executor-mismatch" };
      }

      const idempotencyKey = pending.idempotencyKey ?? this.idempotencyKeys(record.deploymentId, step);
      if (!idempotencyKey.trim()) throw new MetadataError("Runtime deployment idempotency key factory returned an empty key.");

      const lease = await this.deployments.beginNextStep(record.deploymentId, record.revision, {
        executorId: executor.id,
        idempotencyKey,
      });
      record = lease.record;
      const state = this.requireStepState(record, step.id);
      const context: RuntimeDeploymentExecutionContext = {
        deployment: structuredClone(record),
        step: structuredClone(step),
        state: structuredClone(state),
        attempt: state.attempts,
        idempotencyKey,
      };

      let result: RuntimeDeploymentExecutorResult;
      try {
        result = await executor.execute(context);
      } catch (error) {
        record = await this.deployments.failStep(
          record.deploymentId,
          step.id,
          record.revision,
          errorMessage(error),
        );
        return { record, executedSteps: executedSteps + 1, blockedReason: "step-failed" };
      }

      executedSteps += 1;
      if (result.status === "failed") {
        if (!result.error.trim()) throw new MetadataError(`Runtime deployment executor '${executor.id}' returned an empty failure message.`);
        record = await this.deployments.failStep(
          record.deploymentId,
          step.id,
          record.revision,
          result.error,
          this.evidence(result.evidence),
        );
        return { record, executedSteps, blockedReason: "step-failed" };
      }

      record = await this.deployments.completeStep(
        record.deploymentId,
        step.id,
        record.revision,
        this.evidence(result.evidence),
      );
    }

    return { record, executedSteps };
  }

  /**
   * Resolve one uncertain/failed step according to its executor contract, then
   * continue normal execution. Keyed executors may safely replay the same token;
   * reconciled executors must inspect external state first.
   */
  async resume(deploymentId: string, options: RuntimeDeploymentRunOptions = {}): Promise<RuntimeDeploymentRunResult> {
    let record = await this.requireDeployment(deploymentId);
    if (record.status !== "running" && record.status !== "failed") return this.run(deploymentId, options);

    const unresolved = record.steps.find((state) => state.status === "running" || state.status === "failed");
    if (!unresolved) return this.run(deploymentId, options);
    const step = this.requirePlanStep(record, unresolved.stepId);
    const executor = this.executors.get(step.kind);
    if (!executor) return { record, executedSteps: 0, blockedReason: "missing-executor" };
    if (unresolved.executorId === undefined || unresolved.idempotencyKey === undefined) {
      return { record, executedSteps: 0, blockedReason: "recovery-required" };
    }
    if (unresolved.executorId !== executor.id) {
      return { record, executedSteps: 0, blockedReason: "executor-mismatch" };
    }

    if (executor.idempotency === "keyed") {
      record = await this.deployments.recoverStep(
        record.deploymentId,
        step.id,
        record.revision,
        "retry",
      );
      return this.run(record.deploymentId, options);
    }

    const context: RuntimeDeploymentExecutionContext = {
      deployment: structuredClone(record),
      step: structuredClone(step),
      state: structuredClone(unresolved),
      attempt: unresolved.attempts,
      idempotencyKey: unresolved.idempotencyKey,
    };
    const reconciliation = await executor.reconcile!(context);
    if (reconciliation.resolution === "unknown") {
      return { record, executedSteps: 0, blockedReason: "reconciliation-unknown" };
    }
    record = await this.deployments.recoverStep(
      record.deploymentId,
      step.id,
      record.revision,
      reconciliation.resolution,
      reconciliation.resolution === "completed" ? this.evidence(reconciliation.evidence) : undefined,
    );
    return this.run(record.deploymentId, options);
  }

  private evidence(evidence?: RuntimeDeploymentExecutorEvidence): RuntimeDeploymentStepEvidence | undefined {
    if (!evidence) return undefined;
    if (evidence.externalReference !== undefined && !evidence.externalReference.trim()) {
      throw new MetadataError("Runtime deployment executor evidence externalReference cannot be empty.");
    }
    return {
      recordedAt: this.clock().toISOString(),
      ...(evidence.externalReference === undefined ? {} : { externalReference: evidence.externalReference }),
      ...(evidence.details === undefined ? {} : { details: structuredClone(evidence.details) }),
    };
  }

  private async requireDeployment(deploymentId: string): Promise<RuntimeDeploymentRecord> {
    const record = await this.deployments.get(deploymentId);
    if (!record) throw new MetadataError(`Unknown runtime deployment '${deploymentId}'.`);
    return record;
  }

  private requirePlanStep(record: RuntimeDeploymentRecord, stepId: string): RuntimeProfileUpgradeStep {
    const step = record.plan.steps.find((candidate) => candidate.id === stepId);
    if (!step) throw new MetadataError(`Runtime deployment '${record.deploymentId}' is missing plan step '${stepId}'.`);
    return step;
  }

  private requireStepState(record: RuntimeDeploymentRecord, stepId: string): RuntimeDeploymentStepState {
    const state = record.steps.find((candidate) => candidate.stepId === stepId);
    if (!state) throw new MetadataError(`Runtime deployment '${record.deploymentId}' is missing step state '${stepId}'.`);
    return state;
  }
}
