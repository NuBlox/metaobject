import { ConcurrencyError, MetadataError } from "../errors/errors.js";
import type { RuntimeDeploymentStepEvidence } from "./runtime-deployment-store.js";
import type { RuntimeDriftRemediationPlan } from "./runtime-drift-remediation.js";
import type { RuntimePostureSnapshot, RuntimePostureSnapshotStore } from "./runtime-posture.js";

export type RuntimePosturePolicyAction = "ignore" | "notify" | "remediate" | "review";
export type RuntimePostureResponseDisposition = "no-action" | "notify" | "remediate" | "review";

export interface RuntimePosturePolicyContext {
  readonly snapshot: RuntimePostureSnapshot;
}

export interface RuntimePosturePolicyResult {
  readonly action: RuntimePosturePolicyAction;
  readonly message?: string;
  readonly evidence?: RuntimeDeploymentStepEvidence;
}

export interface RuntimePosturePolicy {
  readonly id: string;
  evaluate(context: RuntimePosturePolicyContext): Promise<RuntimePosturePolicyResult> | RuntimePosturePolicyResult;
}

export interface RuntimePosturePolicyDecision extends RuntimePosturePolicyResult {
  readonly policyId: string;
}

export class RuntimePosturePolicyRegistry {
  readonly #policies: RuntimePosturePolicy[] = [];
  readonly #ids = new Set<string>();

  register(policy: RuntimePosturePolicy): this {
    if (!policy.id.trim()) throw new MetadataError("Runtime posture policy id is required.");
    if (this.#ids.has(policy.id)) throw new MetadataError(`Runtime posture policy '${policy.id}' is already registered.`);
    this.#ids.add(policy.id);
    this.#policies.push(policy);
    return this;
  }

  list(): readonly RuntimePosturePolicy[] {
    return [...this.#policies];
  }
}

export interface RuntimePostureResponseRecord {
  readonly format: "nublox-metaobject-runtime-posture-response";
  readonly formatVersion: 1;
  readonly responseId: string;
  readonly runtimeId: string;
  readonly snapshotId: string;
  readonly snapshotState: RuntimePostureSnapshot["state"];
  readonly assessmentId: string;
  readonly disposition: RuntimePostureResponseDisposition;
  readonly decisions: readonly RuntimePosturePolicyDecision[];
  /** Present only when the final disposition is remediate and M24 produced a governed plan. */
  readonly remediationPlanId?: string;
  readonly remediationPlanDisposition?: RuntimeDriftRemediationPlan["disposition"];
  readonly createdAt: string;
}

export interface RuntimePostureResponseFilter {
  readonly runtimeId?: string;
  readonly snapshotId?: string;
  readonly disposition?: RuntimePostureResponseDisposition;
}

/** Create-only response history. Existing policy decisions are immutable evidence. */
export interface RuntimePostureResponseStore {
  get(responseId: string): Promise<RuntimePostureResponseRecord | null>;
  list(filter?: RuntimePostureResponseFilter): Promise<readonly RuntimePostureResponseRecord[]>;
  create(record: RuntimePostureResponseRecord): Promise<RuntimePostureResponseRecord>;
}

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryRuntimePostureResponseStore implements RuntimePostureResponseStore {
  readonly #records = new Map<string, RuntimePostureResponseRecord>();

  async get(responseId: string): Promise<RuntimePostureResponseRecord | null> {
    const record = this.#records.get(responseId);
    return record ? clone(record) : null;
  }

  async list(filter: RuntimePostureResponseFilter = {}): Promise<readonly RuntimePostureResponseRecord[]> {
    return [...this.#records.values()]
      .filter((record) => filter.runtimeId === undefined || record.runtimeId === filter.runtimeId)
      .filter((record) => filter.snapshotId === undefined || record.snapshotId === filter.snapshotId)
      .filter((record) => filter.disposition === undefined || record.disposition === filter.disposition)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.responseId.localeCompare(right.responseId))
      .map(clone);
  }

  async create(record: RuntimePostureResponseRecord): Promise<RuntimePostureResponseRecord> {
    validateRuntimePostureResponseRecord(record);
    if (this.#records.has(record.responseId)) {
      throw new ConcurrencyError(`Runtime posture response '${record.responseId}' already exists.`);
    }
    this.#records.set(record.responseId, clone(record));
    return clone(record);
  }
}

export interface RuntimeDriftRemediationPlanProvider {
  plan(assessmentId: string, remediationPlanId: string): Promise<RuntimeDriftRemediationPlan>;
}

export interface RuntimePostureResponseRequest {
  readonly responseId: string;
  readonly snapshotId: string;
  /** Required when the final policy disposition is remediate. */
  readonly remediationPlanId?: string;
}

export type RuntimePostureResponseClock = () => Date;

const actionRank: Readonly<Record<RuntimePosturePolicyAction, number>> = {
  ignore: 0,
  notify: 1,
  remediate: 2,
  review: 3,
};

function dispositionFor(action: RuntimePosturePolicyAction): RuntimePostureResponseDisposition {
  return action === "ignore" ? "no-action" : action;
}

function validateEvidence(policyId: string, evidence: RuntimeDeploymentStepEvidence | undefined): void {
  if (evidence === undefined) return;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new MetadataError(`Runtime posture policy '${policyId}' evidence must be an object.`);
  }
  if (!evidence.recordedAt.trim()) throw new MetadataError(`Runtime posture policy '${policyId}' evidence recordedAt is required.`);
  if (evidence.externalReference !== undefined && !evidence.externalReference.trim()) {
    throw new MetadataError(`Runtime posture policy '${policyId}' evidence externalReference cannot be empty.`);
  }
}

function validatePolicyResult(policyId: string, result: RuntimePosturePolicyResult): void {
  if (result.action !== "ignore" && result.action !== "notify" && result.action !== "remediate" && result.action !== "review") {
    throw new MetadataError(`Runtime posture policy '${policyId}' returned an invalid action.`);
  }
  if (result.action !== "ignore" && !result.message?.trim()) {
    throw new MetadataError(`Runtime posture policy '${policyId}' action '${result.action}' requires a message.`);
  }
  if (result.message !== undefined && !result.message.trim()) {
    throw new MetadataError(`Runtime posture policy '${policyId}' returned an empty message.`);
  }
  validateEvidence(policyId, result.evidence);
}

function worstAction(decisions: readonly RuntimePosturePolicyDecision[]): RuntimePosturePolicyAction {
  return decisions.reduce<RuntimePosturePolicyAction>(
    (worst, decision) => actionRank[decision.action] > actionRank[worst] ? decision.action : worst,
    "ignore",
  );
}

/**
 * Evaluate immutable M26 posture through ordered caller-supplied policies.
 * Policies can request governed M24 remediation planning, but this catalog never
 * starts deployments or changes external state directly.
 */
export class RuntimePostureResponseCatalog {
  constructor(
    private readonly snapshots: RuntimePostureSnapshotStore,
    private readonly responses: RuntimePostureResponseStore,
    private readonly policies: RuntimePosturePolicyRegistry,
    private readonly remediation?: RuntimeDriftRemediationPlanProvider,
    private readonly clock: RuntimePostureResponseClock = () => new Date(),
  ) {}

  async evaluate(request: RuntimePostureResponseRequest): Promise<RuntimePostureResponseRecord> {
    if (!request.responseId.trim()) throw new MetadataError("Runtime posture response id is required.");
    if (!request.snapshotId.trim()) throw new MetadataError("Runtime posture snapshot id is required.");

    const snapshot = await this.snapshots.get(request.snapshotId);
    if (!snapshot) throw new MetadataError(`Unknown runtime posture snapshot '${request.snapshotId}'.`);

    const history = await this.snapshots.list({ runtimeId: snapshot.runtimeId });
    const latest = history.at(-1);
    if (!latest || latest.snapshotId !== snapshot.snapshotId) {
      throw new MetadataError(
        `Runtime posture snapshot '${snapshot.snapshotId}' is not the latest snapshot for runtime '${snapshot.runtimeId}'.`,
      );
    }

    const registered = this.policies.list();
    if (registered.length === 0) throw new MetadataError("At least one runtime posture policy is required.");

    const decisions: RuntimePosturePolicyDecision[] = [];
    for (const policy of registered) {
      try {
        const result = await policy.evaluate({ snapshot: clone(snapshot) });
        validatePolicyResult(policy.id, result);
        decisions.push({ policyId: policy.id, ...clone(result) });
      } catch (error) {
        const message = error instanceof Error && error.message.trim() ? error.message : String(error);
        decisions.push({
          policyId: policy.id,
          action: "review",
          message: `Policy failed closed: ${message}`,
        });
      }
    }

    let disposition = dispositionFor(worstAction(decisions));
    let remediationPlan: RuntimeDriftRemediationPlan | undefined;

    if (disposition === "remediate") {
      if (!this.remediation || !request.remediationPlanId?.trim()) {
        decisions.push({
          policyId: "$framework",
          action: "review",
          message: "Remediation was requested but no governed remediation planner/id was supplied.",
        });
        disposition = "review";
      } else {
        remediationPlan = await this.remediation.plan(snapshot.assessmentId, request.remediationPlanId);
        if (remediationPlan.disposition !== "remediate" || !remediationPlan.executionPlan) {
          decisions.push({
            policyId: "$framework",
            action: "review",
            message: `M24 remediation planning returned '${remediationPlan.disposition}' instead of an executable remediation plan.`,
          });
          disposition = "review";
        }
      }
    }

    // Re-check latest posture after async policy/remediation work to avoid acting
    // on a snapshot superseded while evaluation was in flight.
    const currentHistory = await this.snapshots.list({ runtimeId: snapshot.runtimeId });
    const currentLatest = currentHistory.at(-1);
    if (!currentLatest || currentLatest.snapshotId !== snapshot.snapshotId) {
      throw new ConcurrencyError(
        `Runtime posture for '${snapshot.runtimeId}' changed during policy evaluation.`,
      );
    }

    const record: RuntimePostureResponseRecord = {
      format: "nublox-metaobject-runtime-posture-response",
      formatVersion: 1,
      responseId: request.responseId,
      runtimeId: snapshot.runtimeId,
      snapshotId: snapshot.snapshotId,
      snapshotState: snapshot.state,
      assessmentId: snapshot.assessmentId,
      disposition,
      decisions,
      ...(remediationPlan === undefined
        ? {}
        : {
            remediationPlanId: remediationPlan.remediationPlanId,
            remediationPlanDisposition: remediationPlan.disposition,
          }),
      createdAt: this.clock().toISOString(),
    };
    return this.responses.create(record);
  }

  async get(responseId: string): Promise<RuntimePostureResponseRecord | null> {
    return this.responses.get(responseId);
  }

  async history(runtimeId: string): Promise<readonly RuntimePostureResponseRecord[]> {
    if (!runtimeId.trim()) throw new MetadataError("Runtime posture runtimeId is required.");
    return this.responses.list({ runtimeId });
  }
}

export function validateRuntimePostureResponseRecord(record: RuntimePostureResponseRecord): void {
  if (record.format !== "nublox-metaobject-runtime-posture-response" || record.formatVersion !== 1) {
    throw new MetadataError("Unsupported runtime posture response format.");
  }
  if (!record.responseId.trim() || !record.runtimeId.trim() || !record.snapshotId.trim() || !record.assessmentId.trim()) {
    throw new MetadataError("Runtime posture response identity fields are required.");
  }
  if (record.decisions.length === 0) throw new MetadataError("Runtime posture response requires at least one policy decision.");
  for (const decision of record.decisions) {
    if (!decision.policyId.trim()) throw new MetadataError("Runtime posture response policyId is required.");
    validatePolicyResult(decision.policyId, decision);
  }
  const expected = dispositionFor(worstAction(record.decisions));
  if (record.disposition !== expected) {
    throw new MetadataError(
      `Runtime posture response disposition '${record.disposition}' does not match policy decisions '${expected}'.`,
    );
  }
  if (record.remediationPlanId !== undefined && !record.remediationPlanId.trim()) {
    throw new MetadataError("Runtime posture response remediationPlanId cannot be empty.");
  }
  if (!record.createdAt.trim()) throw new MetadataError("Runtime posture response createdAt is required.");
}
