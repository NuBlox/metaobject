import { MetadataError } from "../errors/errors.js";
import type { RuntimeProfileUpgradePlan, RuntimeProfileUpgradeStep } from "./runtime-profile-upgrade.js";
import {
  appendRuntimeDeploymentJournal,
  type RuntimeDeploymentJournalEntry,
  type RuntimeDeploymentRecord,
  type RuntimeDeploymentStepEvidence,
  type RuntimeDeploymentStepState,
  type RuntimeDeploymentStore,
} from "./runtime-deployment-store.js";

export type RuntimeDeploymentClock = () => Date;
export type RuntimeDeploymentRecoveryResolution = "retry" | "completed";

export interface RuntimeProfileUpgradePlanProvider {
  plan(profileId: string, fromVersion: number, toVersion: number): Promise<RuntimeProfileUpgradePlan>;
}

export interface RuntimeDeploymentStepLease {
  readonly record: RuntimeDeploymentRecord;
  readonly step: RuntimeProfileUpgradeStep;
}

export interface RuntimeDeploymentStepLeaseMetadata {
  readonly executorId: string;
  readonly idempotencyKey: string;
}

function replaceStep(
  states: readonly RuntimeDeploymentStepState[],
  stepId: string,
  replacement: RuntimeDeploymentStepState,
): readonly RuntimeDeploymentStepState[] {
  return states.map((state) => state.stepId === stepId ? replacement : state);
}

function assertEvidence(evidence: RuntimeDeploymentStepEvidence): void {
  if (!evidence.recordedAt.trim()) throw new MetadataError("Runtime deployment evidence recordedAt is required.");
  if (evidence.externalReference !== undefined && !evidence.externalReference.trim()) {
    throw new MetadataError("Runtime deployment evidence externalReference cannot be empty.");
  }
}

export class RuntimeDeploymentCatalog {
  constructor(
    private readonly store: RuntimeDeploymentStore,
    private readonly upgrades: RuntimeProfileUpgradePlanProvider,
    private readonly clock: RuntimeDeploymentClock = () => new Date(),
  ) {}

  /** Create a durable deployment by freezing the exact M16 plan at creation time. */
  async create(
    deploymentId: string,
    profileId: string,
    fromProfileVersion: number,
    toProfileVersion: number,
  ): Promise<RuntimeDeploymentRecord> {
    if (!deploymentId.trim()) throw new MetadataError("Runtime deployment id is required.");
    if (await this.store.get(deploymentId)) throw new MetadataError(`Runtime deployment '${deploymentId}' already exists.`);
    const plan = await this.upgrades.plan(profileId, fromProfileVersion, toProfileVersion);
    const now = this.clock().toISOString();
    return this.store.save({
      deploymentId,
      status: "planned",
      revision: 0,
      profileId,
      fromProfileVersion,
      toProfileVersion,
      plan: structuredClone(plan),
      steps: plan.steps.map((step) => ({ stepId: step.id, status: "pending", attempts: 0 })),
      journal: appendRuntimeDeploymentJournal(
        { journal: [] },
        { kind: "deployment-created", occurredAt: now },
      ),
      createdAt: now,
      updatedAt: now,
    });
  }

  async get(deploymentId: string): Promise<RuntimeDeploymentRecord | null> {
    return this.store.get(deploymentId);
  }

  async journal(deploymentId: string): Promise<readonly RuntimeDeploymentJournalEntry[]> {
    const record = await this.requireRecord(deploymentId);
    return structuredClone(record.journal ?? []);
  }

  /** Record the explicit operator approval required by a breaking/manual-review plan. */
  async approve(deploymentId: string, expectedRevision: number): Promise<RuntimeDeploymentRecord> {
    const current = await this.requireRecord(deploymentId);
    if (current.status !== "planned") {
      throw new MetadataError(`Runtime deployment '${deploymentId}' must be planned before approval.`);
    }
    const now = this.clock().toISOString();
    return this.store.save({
      ...current,
      approvedAt: now,
      journal: appendRuntimeDeploymentJournal(current, { kind: "deployment-approved", occurredAt: now }),
      updatedAt: now,
    }, expectedRevision);
  }

  async start(deploymentId: string, expectedRevision: number): Promise<RuntimeDeploymentRecord> {
    const current = await this.requireRecord(deploymentId);
    if (current.status !== "planned") {
      throw new MetadataError(`Runtime deployment '${deploymentId}' must be planned before start.`);
    }
    if (current.plan.requiresManualReview && !current.approvedAt) {
      throw new MetadataError(`Runtime deployment '${deploymentId}' requires explicit approval before start.`);
    }
    const now = this.clock().toISOString();
    if (current.steps.length === 0) {
      return this.store.save({
        ...current,
        status: "completed",
        startedAt: now,
        completedAt: now,
        journal: appendRuntimeDeploymentJournal(
          current,
          { kind: "deployment-started", occurredAt: now },
          { kind: "deployment-completed", occurredAt: now },
        ),
        updatedAt: now,
      }, expectedRevision);
    }
    return this.store.save({
      ...current,
      status: "running",
      startedAt: now,
      journal: appendRuntimeDeploymentJournal(current, { kind: "deployment-started", occurredAt: now }),
      updatedAt: now,
    }, expectedRevision);
  }

  /**
   * Persist a lease on the next pending step before external execution starts.
   * Optional executor metadata is locked into the durable step state. Once a
   * step has an executor/idempotency key, retries must reuse the same values.
   */
  async beginNextStep(
    deploymentId: string,
    expectedRevision: number,
    metadata?: RuntimeDeploymentStepLeaseMetadata,
  ): Promise<RuntimeDeploymentStepLease> {
    const current = await this.requireRecord(deploymentId);
    if (current.status !== "running") {
      throw new MetadataError(`Runtime deployment '${deploymentId}' must be running before a step can begin.`);
    }
    const inFlight = current.steps.find((step) => step.status === "running");
    if (inFlight) {
      throw new MetadataError(
        `Runtime deployment '${deploymentId}' has unresolved running step '${inFlight.stepId}'; recover it explicitly.`,
      );
    }
    const failed = current.steps.find((step) => step.status === "failed");
    if (failed) throw new MetadataError(`Runtime deployment '${deploymentId}' has failed step '${failed.stepId}'.`);
    const pending = current.steps.find((step) => step.status === "pending");
    if (!pending) throw new MetadataError(`Runtime deployment '${deploymentId}' has no pending step.`);
    const definition = current.plan.steps.find((step) => step.id === pending.stepId);
    if (!definition) throw new MetadataError(`Runtime deployment '${deploymentId}' is missing plan step '${pending.stepId}'.`);

    if (metadata) {
      if (!metadata.executorId.trim()) throw new MetadataError("Runtime deployment executor id is required.");
      if (!metadata.idempotencyKey.trim()) throw new MetadataError("Runtime deployment idempotency key is required.");
      if (pending.executorId !== undefined && pending.executorId !== metadata.executorId) {
        throw new MetadataError(
          `Runtime deployment step '${pending.stepId}' is locked to executor '${pending.executorId}', not '${metadata.executorId}'.`,
        );
      }
      if (pending.idempotencyKey !== undefined && pending.idempotencyKey !== metadata.idempotencyKey) {
        throw new MetadataError(`Runtime deployment step '${pending.stepId}' idempotency key cannot change between attempts.`);
      }
    }

    const executorId = pending.executorId ?? metadata?.executorId;
    const idempotencyKey = pending.idempotencyKey ?? metadata?.idempotencyKey;
    const now = this.clock().toISOString();
    const nextState: RuntimeDeploymentStepState = {
      stepId: pending.stepId,
      status: "running",
      attempts: pending.attempts + 1,
      ...(executorId === undefined ? {} : { executorId }),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      startedAt: now,
    };
    const record = await this.store.save({
      ...current,
      steps: replaceStep(current.steps, pending.stepId, nextState),
      journal: appendRuntimeDeploymentJournal(current, {
        kind: "step-leased",
        occurredAt: now,
        stepId: pending.stepId,
        attempt: nextState.attempts,
        ...(executorId === undefined ? {} : { executorId }),
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      }),
      updatedAt: now,
    }, expectedRevision);
    return { record, step: structuredClone(definition) };
  }

  async completeStep(
    deploymentId: string,
    stepId: string,
    expectedRevision: number,
    evidence?: RuntimeDeploymentStepEvidence,
  ): Promise<RuntimeDeploymentRecord> {
    const current = await this.requireRecord(deploymentId);
    if (current.status !== "running") throw new MetadataError(`Runtime deployment '${deploymentId}' is not running.`);
    const state = this.requireStep(current, stepId);
    if (state.status !== "running") {
      throw new MetadataError(`Runtime deployment step '${stepId}' must be running before completion.`);
    }
    if (evidence) assertEvidence(evidence);
    const now = this.clock().toISOString();
    const steps = replaceStep(current.steps, stepId, {
      ...state,
      status: "completed",
      completedAt: now,
      ...(evidence === undefined ? {} : { evidence: structuredClone(evidence) }),
    });
    const complete = steps.every((step) => step.status === "completed");
    const journalEvents = [
      {
        kind: "step-completed" as const,
        occurredAt: now,
        stepId,
        attempt: state.attempts,
        ...(state.executorId === undefined ? {} : { executorId: state.executorId }),
        ...(state.idempotencyKey === undefined ? {} : { idempotencyKey: state.idempotencyKey }),
        ...(evidence === undefined ? {} : { evidence: structuredClone(evidence) }),
      },
      ...(complete ? [{ kind: "deployment-completed" as const, occurredAt: now }] : []),
    ];
    return this.store.save({
      ...current,
      status: complete ? "completed" : "running",
      steps,
      journal: appendRuntimeDeploymentJournal(current, ...journalEvents),
      ...(complete ? { completedAt: now } : {}),
      updatedAt: now,
    }, expectedRevision);
  }

  async failStep(
    deploymentId: string,
    stepId: string,
    expectedRevision: number,
    error: string,
    evidence?: RuntimeDeploymentStepEvidence,
  ): Promise<RuntimeDeploymentRecord> {
    const current = await this.requireRecord(deploymentId);
    if (current.status !== "running") throw new MetadataError(`Runtime deployment '${deploymentId}' is not running.`);
    const state = this.requireStep(current, stepId);
    if (state.status !== "running") throw new MetadataError(`Runtime deployment step '${stepId}' is not running.`);
    if (!error.trim()) throw new MetadataError("Runtime deployment step failure requires an error message.");
    if (evidence) assertEvidence(evidence);
    const now = this.clock().toISOString();
    return this.store.save({
      ...current,
      status: "failed",
      steps: replaceStep(current.steps, stepId, {
        ...state,
        status: "failed",
        lastError: error,
        ...(evidence === undefined ? {} : { evidence: structuredClone(evidence) }),
      }),
      journal: appendRuntimeDeploymentJournal(current, {
        kind: "step-failed",
        occurredAt: now,
        stepId,
        attempt: state.attempts,
        error,
        ...(state.executorId === undefined ? {} : { executorId: state.executorId }),
        ...(state.idempotencyKey === undefined ? {} : { idempotencyKey: state.idempotencyKey }),
        ...(evidence === undefined ? {} : { evidence: structuredClone(evidence) }),
      }),
      updatedAt: now,
    }, expectedRevision);
  }

  /**
   * Resolve a failed step or an in-flight step left by an interrupted process.
   * `retry` returns it to pending while preserving the locked executor/key;
   * `completed` confirms the external side effect already succeeded.
   */
  async recoverStep(
    deploymentId: string,
    stepId: string,
    expectedRevision: number,
    resolution: RuntimeDeploymentRecoveryResolution,
    evidence?: RuntimeDeploymentStepEvidence,
  ): Promise<RuntimeDeploymentRecord> {
    const current = await this.requireRecord(deploymentId);
    if (current.status !== "running" && current.status !== "failed") {
      throw new MetadataError(`Runtime deployment '${deploymentId}' is not recoverable from status '${current.status}'.`);
    }
    const state = this.requireStep(current, stepId);
    if (state.status !== "running" && state.status !== "failed") {
      throw new MetadataError(`Runtime deployment step '${stepId}' is not running or failed.`);
    }
    if (evidence) assertEvidence(evidence);
    const now = this.clock().toISOString();
    const recovered: RuntimeDeploymentStepState = resolution === "retry"
      ? {
          stepId,
          status: "pending",
          attempts: state.attempts,
          ...(state.executorId === undefined ? {} : { executorId: state.executorId }),
          ...(state.idempotencyKey === undefined ? {} : { idempotencyKey: state.idempotencyKey }),
        }
      : {
          ...state,
          status: "completed",
          completedAt: now,
          ...(evidence === undefined ? {} : { evidence: structuredClone(evidence) }),
        };
    const steps = replaceStep(current.steps, stepId, recovered);
    const complete = steps.every((step) => step.status === "completed");
    const recoveryEvent = resolution === "retry"
      ? {
          kind: "step-retry-requested" as const,
          occurredAt: now,
          stepId,
          attempt: state.attempts,
          recoveryResolution: "retry" as const,
          ...(state.executorId === undefined ? {} : { executorId: state.executorId }),
          ...(state.idempotencyKey === undefined ? {} : { idempotencyKey: state.idempotencyKey }),
        }
      : {
          kind: "step-recovered-completed" as const,
          occurredAt: now,
          stepId,
          attempt: state.attempts,
          recoveryResolution: "completed" as const,
          ...(state.executorId === undefined ? {} : { executorId: state.executorId }),
          ...(state.idempotencyKey === undefined ? {} : { idempotencyKey: state.idempotencyKey }),
          ...(evidence === undefined ? {} : { evidence: structuredClone(evidence) }),
        };
    return this.store.save({
      ...current,
      status: complete ? "completed" : "running",
      steps,
      journal: appendRuntimeDeploymentJournal(
        current,
        recoveryEvent,
        ...(complete ? [{ kind: "deployment-completed" as const, occurredAt: now }] : []),
      ),
      ...(complete ? { completedAt: now } : {}),
      updatedAt: now,
    }, expectedRevision);
  }

  /** Record a reconciler's explicit inability to determine an external outcome. */
  async recordUnknownReconciliation(
    deploymentId: string,
    stepId: string,
    expectedRevision: number,
  ): Promise<RuntimeDeploymentRecord> {
    const current = await this.requireRecord(deploymentId);
    if (current.status !== "running" && current.status !== "failed") {
      throw new MetadataError(`Runtime deployment '${deploymentId}' is not reconcilable from status '${current.status}'.`);
    }
    const state = this.requireStep(current, stepId);
    if (state.status !== "running" && state.status !== "failed") {
      throw new MetadataError(`Runtime deployment step '${stepId}' is not running or failed.`);
    }
    const now = this.clock().toISOString();
    return this.store.save({
      ...current,
      journal: appendRuntimeDeploymentJournal(current, {
        kind: "step-reconciliation-unknown",
        occurredAt: now,
        stepId,
        attempt: state.attempts,
        recoveryResolution: "unknown",
        ...(state.executorId === undefined ? {} : { executorId: state.executorId }),
        ...(state.idempotencyKey === undefined ? {} : { idempotencyKey: state.idempotencyKey }),
      }),
      updatedAt: now,
    }, expectedRevision);
  }

  /** Cancel only before execution starts; partial external work must be recovered, not hidden as cancellation. */
  async cancel(deploymentId: string, expectedRevision: number): Promise<RuntimeDeploymentRecord> {
    const current = await this.requireRecord(deploymentId);
    if (current.status !== "planned") {
      throw new MetadataError(`Only a planned runtime deployment can be cancelled: '${deploymentId}'.`);
    }
    const now = this.clock().toISOString();
    return this.store.save({
      ...current,
      status: "cancelled",
      cancelledAt: now,
      journal: appendRuntimeDeploymentJournal(current, { kind: "deployment-cancelled", occurredAt: now }),
      updatedAt: now,
    }, expectedRevision);
  }

  private async requireRecord(deploymentId: string): Promise<RuntimeDeploymentRecord> {
    const record = await this.store.get(deploymentId);
    if (!record) throw new MetadataError(`Unknown runtime deployment '${deploymentId}'.`);
    return record;
  }

  private requireStep(record: RuntimeDeploymentRecord, stepId: string): RuntimeDeploymentStepState {
    const state = record.steps.find((step) => step.stepId === stepId);
    if (!state) throw new MetadataError(`Unknown runtime deployment step '${stepId}'.`);
    return state;
  }
}
