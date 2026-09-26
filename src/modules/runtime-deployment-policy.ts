import { MetadataError } from "../errors/errors.js";
import {
  appendRuntimeDeploymentJournal,
  type RuntimeDeploymentJournalEvent,
  type RuntimeDeploymentRecord,
  type RuntimeDeploymentStore,
} from "./runtime-deployment-store.js";

export type RuntimeDeploymentPolicyOutcome = "allow" | "warn" | "deny";

export interface RuntimeDeploymentPolicyEvidence {
  readonly externalReference?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface RuntimeDeploymentPolicyResult {
  readonly outcome: RuntimeDeploymentPolicyOutcome;
  readonly message?: string;
  readonly evidence?: RuntimeDeploymentPolicyEvidence;
}

export interface RuntimeDeploymentPolicyEvaluation extends RuntimeDeploymentPolicyResult {
  readonly policyId: string;
}

export interface RuntimeDeploymentPolicyContext {
  readonly deployment: RuntimeDeploymentRecord;
}

export interface RuntimeDeploymentPolicy {
  readonly id: string;
  readonly description?: string;
  evaluate(
    context: RuntimeDeploymentPolicyContext,
  ): Promise<RuntimeDeploymentPolicyResult> | RuntimeDeploymentPolicyResult;
}

export interface RuntimeDeploymentPolicyReport {
  readonly allowed: boolean;
  readonly hasWarnings: boolean;
  readonly evaluations: readonly RuntimeDeploymentPolicyEvaluation[];
}

export interface RuntimeDeploymentPolicyGateResult {
  readonly record: RuntimeDeploymentRecord;
  readonly report: RuntimeDeploymentPolicyReport;
}

export type RuntimeDeploymentPolicyClock = () => Date;

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "unknown policy error";
}

function validateResult(policyId: string, result: RuntimeDeploymentPolicyResult): void {
  if (result.outcome !== "allow" && result.outcome !== "warn" && result.outcome !== "deny") {
    throw new MetadataError(`Runtime deployment policy '${policyId}' returned an invalid outcome.`);
  }
  if (result.outcome !== "allow" && !result.message?.trim()) {
    throw new MetadataError(`Runtime deployment policy '${policyId}' ${result.outcome} result requires a message.`);
  }
  if (result.message !== undefined && !result.message.trim()) {
    throw new MetadataError(`Runtime deployment policy '${policyId}' returned an empty message.`);
  }
  if (result.evidence?.externalReference !== undefined && !result.evidence.externalReference.trim()) {
    throw new MetadataError(`Runtime deployment policy '${policyId}' returned an empty externalReference.`);
  }
}

/** Ordered registry and fail-closed evaluator for pre-deployment policies. */
export class RuntimeDeploymentPolicyRegistry {
  readonly #policies = new Map<string, RuntimeDeploymentPolicy>();

  register(policy: RuntimeDeploymentPolicy): this {
    if (!policy.id.trim()) throw new MetadataError("Runtime deployment policy id is required.");
    if (this.#policies.has(policy.id)) {
      throw new MetadataError(`Runtime deployment policy '${policy.id}' is already registered.`);
    }
    this.#policies.set(policy.id, policy);
    return this;
  }

  has(policyId: string): boolean {
    return this.#policies.has(policyId);
  }

  list(): readonly RuntimeDeploymentPolicy[] {
    return [...this.#policies.values()];
  }

  /**
   * Evaluate every registered policy in deterministic registration order.
   * A thrown/invalid policy result fails closed as a denial rather than allowing
   * a deployment to start without a trustworthy decision.
   */
  async evaluate(deployment: RuntimeDeploymentRecord): Promise<RuntimeDeploymentPolicyReport> {
    const evaluations: RuntimeDeploymentPolicyEvaluation[] = [];
    for (const policy of this.#policies.values()) {
      try {
        const result = await policy.evaluate({ deployment: structuredClone(deployment) });
        validateResult(policy.id, result);
        evaluations.push({ policyId: policy.id, ...structuredClone(result) });
      } catch (error) {
        evaluations.push({
          policyId: policy.id,
          outcome: "deny",
          message: `Policy evaluation failed: ${errorMessage(error)}`,
        });
      }
    }
    return {
      allowed: evaluations.every((evaluation) => evaluation.outcome !== "deny"),
      hasWarnings: evaluations.some((evaluation) => evaluation.outcome === "warn"),
      evaluations,
    };
  }
}

/**
 * Evaluate a planned deployment and atomically append every policy decision to
 * its M19/M20 journal before the caller decides whether the deployment may start.
 */
export class RuntimeDeploymentPolicyGate {
  constructor(
    private readonly store: RuntimeDeploymentStore,
    private readonly policies: RuntimeDeploymentPolicyRegistry,
    private readonly clock: RuntimeDeploymentPolicyClock = () => new Date(),
  ) {}

  async evaluate(record: RuntimeDeploymentRecord): Promise<RuntimeDeploymentPolicyGateResult> {
    if (record.status !== "planned") {
      throw new MetadataError(`Runtime deployment '${record.deploymentId}' must be planned for preflight policy evaluation.`);
    }

    const report = await this.policies.evaluate(record);
    if (report.evaluations.length === 0) return { record, report };

    const occurredAt = this.clock().toISOString();
    const events: RuntimeDeploymentJournalEvent[] = report.evaluations.map((evaluation) => ({
      kind: "deployment-policy-evaluated",
      occurredAt,
      policyId: evaluation.policyId,
      policyOutcome: evaluation.outcome,
      ...(evaluation.message === undefined ? {} : { message: evaluation.message }),
      ...(evaluation.evidence === undefined
        ? {}
        : {
            evidence: {
              recordedAt: occurredAt,
              ...(evaluation.evidence.externalReference === undefined
                ? {}
                : { externalReference: evaluation.evidence.externalReference }),
              ...(evaluation.evidence.details === undefined
                ? {}
                : { details: structuredClone(evaluation.evidence.details) }),
            },
          }),
    }));

    const stored = await this.store.save({
      ...record,
      journal: appendRuntimeDeploymentJournal(record, ...events),
      updatedAt: occurredAt,
    }, record.revision);
    return { record: stored, report };
  }
}
