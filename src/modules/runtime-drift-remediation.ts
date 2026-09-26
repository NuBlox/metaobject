import { ConcurrencyError, MetadataError } from "../errors/errors.js";
import type { SchemaChangeImpact } from "../evolution/schema-evolution.js";
import type { RuntimeProfileUpgradePlanProvider } from "./runtime-deployment-catalog.js";
import type {
  RuntimeDeploymentDriftAssessment,
  RuntimeDeploymentDriftAssessmentStore,
  RuntimeDeploymentDriftBaseline,
  RuntimeDeploymentDriftBaselineStore,
  RuntimeDeploymentDriftCheck,
} from "./runtime-deployment-drift.js";
import type {
  RuntimeDeploymentRecord,
  RuntimeDeploymentStepEvidence,
  RuntimeDeploymentStore,
} from "./runtime-deployment-store.js";
import type {
  RuntimeProfileUpgradePlan,
  RuntimeProfileUpgradeStep,
  RuntimeProfileUpgradeStepKind,
} from "./runtime-profile-upgrade.js";

export type RuntimeDriftAuthorization = "authorized" | "unauthorized" | "unknown";

export interface RuntimeDriftClassificationResult {
  readonly classification: RuntimeDriftAuthorization;
  readonly message?: string;
  readonly evidence?: RuntimeDeploymentStepEvidence;
}

export interface RuntimeDriftClassificationContext {
  readonly deployment: RuntimeDeploymentRecord;
  readonly baseline: RuntimeDeploymentDriftBaseline;
  readonly assessment: RuntimeDeploymentDriftAssessment;
  readonly check: RuntimeDeploymentDriftCheck;
}

export interface RuntimeDriftClassifier {
  readonly probeId: string;
  classify(
    context: RuntimeDriftClassificationContext,
  ): Promise<RuntimeDriftClassificationResult> | RuntimeDriftClassificationResult;
}

export class RuntimeDriftClassifierRegistry {
  readonly #classifiers = new Map<string, RuntimeDriftClassifier>();

  register(classifier: RuntimeDriftClassifier): this {
    if (!classifier.probeId.trim()) throw new MetadataError("Runtime drift classifier probeId is required.");
    if (this.#classifiers.has(classifier.probeId)) {
      throw new MetadataError(`Runtime drift classifier for '${classifier.probeId}' is already registered.`);
    }
    this.#classifiers.set(classifier.probeId, classifier);
    return this;
  }

  get(probeId: string): RuntimeDriftClassifier | null {
    return this.#classifiers.get(probeId) ?? null;
  }
}

export type RuntimeDriftRemediationStepInput = Omit<RuntimeProfileUpgradeStep, "id">;

export interface RuntimeDriftRemediationHandlerContext extends RuntimeDriftClassificationContext {
  readonly classification: RuntimeDriftClassificationResult;
}

export interface RuntimeDriftRemediationHandler {
  readonly probeId: string;
  plan(
    context: RuntimeDriftRemediationHandlerContext,
  ): Promise<readonly RuntimeDriftRemediationStepInput[]> | readonly RuntimeDriftRemediationStepInput[];
}

export class RuntimeDriftRemediationHandlerRegistry {
  readonly #handlers = new Map<string, RuntimeDriftRemediationHandler>();

  register(handler: RuntimeDriftRemediationHandler): this {
    if (!handler.probeId.trim()) throw new MetadataError("Runtime drift remediation handler probeId is required.");
    if (this.#handlers.has(handler.probeId)) {
      throw new MetadataError(`Runtime drift remediation handler for '${handler.probeId}' is already registered.`);
    }
    this.#handlers.set(handler.probeId, handler);
    return this;
  }

  get(probeId: string): RuntimeDriftRemediationHandler | null {
    return this.#handlers.get(probeId) ?? null;
  }
}

export type RuntimeDriftRemediationAction = "accept" | "remediate" | "review";
export type RuntimeDriftRemediationDisposition = "no-action" | "accepted" | "remediate" | "review";

export interface RuntimeDriftRemediationDecision {
  readonly probeId: string;
  readonly checkStatus: "changed" | "unverifiable";
  readonly classification: RuntimeDriftAuthorization;
  readonly action: RuntimeDriftRemediationAction;
  readonly message: string;
  readonly evidence?: RuntimeDeploymentStepEvidence;
  readonly stepIds: readonly string[];
}

export interface RuntimeDriftRemediationExecutionPlan extends RuntimeProfileUpgradePlan {
  readonly remediationPlanId: string;
  readonly assessmentId: string;
  readonly baselineId: string;
}

export interface RuntimeDriftRemediationPlan {
  readonly format: "nublox-metaobject-runtime-drift-remediation";
  readonly formatVersion: 1;
  readonly remediationPlanId: string;
  readonly assessmentId: string;
  readonly baselineId: string;
  readonly deploymentId: string;
  readonly deploymentRevision: number;
  readonly profileId: string;
  readonly profileVersion: number;
  readonly disposition: RuntimeDriftRemediationDisposition;
  readonly requiresManualReview: boolean;
  readonly requiresBaselineRefresh: boolean;
  readonly decisions: readonly RuntimeDriftRemediationDecision[];
  readonly steps: readonly RuntimeProfileUpgradeStep[];
  readonly executionPlan?: RuntimeDriftRemediationExecutionPlan;
  readonly createdAt: string;
}

export interface RuntimeDriftRemediationPlanFilter {
  readonly assessmentId?: string;
  readonly deploymentId?: string;
  readonly disposition?: RuntimeDriftRemediationDisposition;
}

/** Create-only persistence contract for immutable remediation decisions/plans. */
export interface RuntimeDriftRemediationPlanStore {
  get(remediationPlanId: string): Promise<RuntimeDriftRemediationPlan | null>;
  list(filter?: RuntimeDriftRemediationPlanFilter): Promise<readonly RuntimeDriftRemediationPlan[]>;
  create(plan: RuntimeDriftRemediationPlan): Promise<RuntimeDriftRemediationPlan>;
}

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryRuntimeDriftRemediationPlanStore implements RuntimeDriftRemediationPlanStore {
  readonly #records = new Map<string, RuntimeDriftRemediationPlan>();

  async get(remediationPlanId: string): Promise<RuntimeDriftRemediationPlan | null> {
    const record = this.#records.get(remediationPlanId);
    return record ? clone(record) : null;
  }

  async list(filter: RuntimeDriftRemediationPlanFilter = {}): Promise<readonly RuntimeDriftRemediationPlan[]> {
    return [...this.#records.values()]
      .filter((record) => filter.assessmentId === undefined || record.assessmentId === filter.assessmentId)
      .filter((record) => filter.deploymentId === undefined || record.deploymentId === filter.deploymentId)
      .filter((record) => filter.disposition === undefined || record.disposition === filter.disposition)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.remediationPlanId.localeCompare(right.remediationPlanId))
      .map(clone);
  }

  async create(plan: RuntimeDriftRemediationPlan): Promise<RuntimeDriftRemediationPlan> {
    validateRuntimeDriftRemediationPlan(plan);
    if (this.#records.has(plan.remediationPlanId)) {
      throw new ConcurrencyError(`Runtime drift remediation plan '${plan.remediationPlanId}' already exists.`);
    }
    this.#records.set(plan.remediationPlanId, clone(plan));
    return clone(plan);
  }
}

const supportedStepKinds = new Set<RuntimeProfileUpgradeStepKind>([
  "add-module",
  "upgrade-module",
  "downgrade-module",
  "add-object-type",
  "migrate-object-type",
  "downgrade-object-type",
  "move-object-type",
  "remove-object-type",
  "remove-module",
]);

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "unknown error";
}

function validateEvidence(label: string, evidence: RuntimeDeploymentStepEvidence | undefined): void {
  if (evidence === undefined) return;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new MetadataError(`${label} evidence must be an object.`);
  }
  if (!evidence.recordedAt.trim()) throw new MetadataError(`${label} evidence recordedAt is required.`);
  if (evidence.externalReference !== undefined && !evidence.externalReference.trim()) {
    throw new MetadataError(`${label} evidence externalReference cannot be empty.`);
  }
  if (evidence.details !== undefined && (!evidence.details || typeof evidence.details !== "object" || Array.isArray(evidence.details))) {
    throw new MetadataError(`${label} evidence details must be an object.`);
  }
}

function validateClassification(probeId: string, result: RuntimeDriftClassificationResult): void {
  if (
    result.classification !== "authorized"
    && result.classification !== "unauthorized"
    && result.classification !== "unknown"
  ) {
    throw new MetadataError(`Runtime drift classifier '${probeId}' returned an invalid classification.`);
  }
  if (result.message !== undefined && !result.message.trim()) {
    throw new MetadataError(`Runtime drift classifier '${probeId}' returned an empty message.`);
  }
  validateEvidence(`Runtime drift classifier '${probeId}'`, result.evidence);
}

function validateStepInput(probeId: string, step: RuntimeDriftRemediationStepInput): void {
  if (!supportedStepKinds.has(step.kind)) {
    throw new MetadataError(`Runtime drift remediation handler '${probeId}' returned unsupported step kind '${String(step.kind)}'.`);
  }
  if (!step.moduleId.trim()) throw new MetadataError(`Runtime drift remediation handler '${probeId}' returned a step without moduleId.`);
  if (!step.description.trim()) throw new MetadataError(`Runtime drift remediation handler '${probeId}' returned a step without description.`);
}

function sameDeploymentSnapshot(current: RuntimeDeploymentRecord, expectedRevision: number, baseline: RuntimeDeploymentDriftBaseline): boolean {
  return current.revision === expectedRevision
    && current.deploymentId === baseline.deploymentId
    && current.profileId === baseline.profileId
    && current.toProfileVersion === baseline.profileVersion;
}

function impactForSteps(steps: readonly RuntimeProfileUpgradeStep[]): SchemaChangeImpact {
  if (steps.some((step) => step.requiresManualReview)) return "breaking";
  if (steps.some((step) => step.blocking)) return "requires-migration";
  return "compatible";
}

export type RuntimeDriftRemediationClock = () => Date;

export class RuntimeDriftRemediationCatalog {
  constructor(
    private readonly deployments: RuntimeDeploymentStore,
    private readonly baselines: RuntimeDeploymentDriftBaselineStore,
    private readonly assessments: RuntimeDeploymentDriftAssessmentStore,
    private readonly plans: RuntimeDriftRemediationPlanStore,
    private readonly classifiers: RuntimeDriftClassifierRegistry,
    private readonly handlers: RuntimeDriftRemediationHandlerRegistry,
    private readonly clock: RuntimeDriftRemediationClock = () => new Date(),
  ) {}

  async plan(assessmentId: string, remediationPlanId: string): Promise<RuntimeDriftRemediationPlan> {
    if (!remediationPlanId.trim()) throw new MetadataError("Runtime drift remediation plan id is required.");
    const assessment = await this.assessments.get(assessmentId);
    if (!assessment) throw new MetadataError(`Unknown runtime drift assessment '${assessmentId}'.`);
    const baseline = await this.baselines.get(assessment.baselineId);
    if (!baseline) throw new MetadataError(`Unknown runtime drift baseline '${assessment.baselineId}'.`);
    if (baseline.deploymentId !== assessment.deploymentId) {
      throw new MetadataError(`Runtime drift assessment '${assessmentId}' does not match baseline deployment '${baseline.deploymentId}'.`);
    }
    const deployment = await this.deployments.get(assessment.deploymentId);
    if (!deployment || deployment.status !== "completed" || !deployment.steps.every((step) => step.status === "completed")) {
      throw new MetadataError(`Runtime drift assessment '${assessmentId}' does not reference a completed deployment.`);
    }
    if (!sameDeploymentSnapshot(deployment, assessment.deploymentRevision, baseline)) {
      throw new ConcurrencyError(`Runtime deployment '${deployment.deploymentId}' changed after drift assessment '${assessmentId}'.`);
    }

    const decisions: RuntimeDriftRemediationDecision[] = [];
    const steps: RuntimeProfileUpgradeStep[] = [];
    let requiresBaselineRefresh = false;
    let unresolved = false;

    for (const check of assessment.checks) {
      if (check.status === "unchanged") continue;

      if (check.status === "unverifiable") {
        unresolved = true;
        decisions.push({
          probeId: check.probeId,
          checkStatus: "unverifiable",
          classification: "unknown",
          action: "review",
          message: check.message ?? "The runtime invariant could not be verified; manual review is required.",
          ...(check.evidence === undefined ? {} : { evidence: clone(check.evidence) }),
          stepIds: [],
        });
        continue;
      }

      const classifier = this.classifiers.get(check.probeId);
      let classification: RuntimeDriftClassificationResult;
      if (!classifier) {
        classification = {
          classification: "unknown",
          message: `No drift classifier is registered for '${check.probeId}'.`,
        };
      } else {
        try {
          const result = await classifier.classify({
            deployment: clone(deployment),
            baseline: clone(baseline),
            assessment: clone(assessment),
            check: clone(check),
          });
          validateClassification(check.probeId, result);
          classification = clone(result);
        } catch (error) {
          classification = {
            classification: "unknown",
            message: `Drift classification failed closed: ${errorMessage(error)}`,
          };
        }
      }

      if (classification.classification === "authorized") {
        requiresBaselineRefresh = true;
        decisions.push({
          probeId: check.probeId,
          checkStatus: "changed",
          classification: "authorized",
          action: "accept",
          message: classification.message ?? "The observed divergence is explicitly authorized.",
          ...(classification.evidence === undefined ? {} : { evidence: clone(classification.evidence) }),
          stepIds: [],
        });
        continue;
      }

      if (classification.classification !== "unauthorized") {
        unresolved = true;
        decisions.push({
          probeId: check.probeId,
          checkStatus: "changed",
          classification: "unknown",
          action: "review",
          message: classification.message ?? "The observed divergence could not be classified safely.",
          ...(classification.evidence === undefined ? {} : { evidence: clone(classification.evidence) }),
          stepIds: [],
        });
        continue;
      }

      const handler = this.handlers.get(check.probeId);
      if (!handler) {
        unresolved = true;
        decisions.push({
          probeId: check.probeId,
          checkStatus: "changed",
          classification: "unauthorized",
          action: "review",
          message: classification.message ?? `Unauthorized drift '${check.probeId}' has no remediation handler.`,
          ...(classification.evidence === undefined ? {} : { evidence: clone(classification.evidence) }),
          stepIds: [],
        });
        continue;
      }

      try {
        const candidates = await handler.plan({
          deployment: clone(deployment),
          baseline: clone(baseline),
          assessment: clone(assessment),
          check: clone(check),
          classification: clone(classification),
        });
        if (candidates.length === 0) throw new MetadataError("remediation handler returned no steps");
        const stepIds: string[] = [];
        for (const candidate of candidates) {
          validateStepInput(check.probeId, candidate);
          const id = `${String(steps.length + 1).padStart(3, "0")}:drift:${check.probeId}:${candidate.kind}`;
          const step: RuntimeProfileUpgradeStep = { ...clone(candidate), id };
          steps.push(step);
          stepIds.push(id);
        }
        decisions.push({
          probeId: check.probeId,
          checkStatus: "changed",
          classification: "unauthorized",
          action: "remediate",
          message: classification.message ?? "Unauthorized divergence has a governed remediation plan.",
          ...(classification.evidence === undefined ? {} : { evidence: clone(classification.evidence) }),
          stepIds,
        });
      } catch (error) {
        unresolved = true;
        decisions.push({
          probeId: check.probeId,
          checkStatus: "changed",
          classification: "unauthorized",
          action: "review",
          message: `Remediation planning failed: ${errorMessage(error)}`,
          ...(classification.evidence === undefined ? {} : { evidence: clone(classification.evidence) }),
          stepIds: [],
        });
      }
    }

    const stepManualReview = steps.some((step) => step.requiresManualReview);
    const disposition: RuntimeDriftRemediationDisposition = unresolved
      ? "review"
      : steps.length > 0
        ? "remediate"
        : requiresBaselineRefresh
          ? "accepted"
          : "no-action";
    const requiresManualReview = unresolved || stepManualReview;

    const executionPlan: RuntimeDriftRemediationExecutionPlan | undefined = disposition === "remediate"
      ? {
          format: "nublox-metaobject-runtime-profile-upgrade",
          formatVersion: 1,
          remediationPlanId,
          assessmentId,
          baselineId: baseline.baselineId,
          profileId: baseline.profileId,
          fromProfileVersion: baseline.profileVersion,
          toProfileVersion: baseline.profileVersion,
          impact: impactForSteps(steps),
          requiresManualReview: stepManualReview,
          blockingStepCount: steps.filter((step) => step.blocking).length,
          moduleChanges: [],
          objectChanges: [],
          steps: clone(steps),
        }
      : undefined;

    const plan: RuntimeDriftRemediationPlan = {
      format: "nublox-metaobject-runtime-drift-remediation",
      formatVersion: 1,
      remediationPlanId,
      assessmentId,
      baselineId: baseline.baselineId,
      deploymentId: deployment.deploymentId,
      deploymentRevision: deployment.revision,
      profileId: baseline.profileId,
      profileVersion: baseline.profileVersion,
      disposition,
      requiresManualReview,
      requiresBaselineRefresh,
      decisions,
      steps,
      ...(executionPlan === undefined ? {} : { executionPlan }),
      createdAt: this.clock().toISOString(),
    };
    return this.plans.create(plan);
  }

  async get(remediationPlanId: string): Promise<RuntimeDriftRemediationPlan | null> {
    return this.plans.get(remediationPlanId);
  }
}

/**
 * Adapter that feeds one immutable M24 remediation plan into the existing
 * M17/M18 deployment catalogue/runner without introducing a second executor.
 */
export class RuntimeDriftRemediationPlanProvider implements RuntimeProfileUpgradePlanProvider {
  constructor(
    private readonly plans: RuntimeDriftRemediationPlanStore,
    private readonly remediationPlanId: string,
  ) {}

  async plan(profileId: string, fromVersion: number, toVersion: number): Promise<RuntimeProfileUpgradePlan> {
    const remediation = await this.plans.get(this.remediationPlanId);
    if (!remediation) throw new MetadataError(`Unknown runtime drift remediation plan '${this.remediationPlanId}'.`);
    if (!remediation.executionPlan || remediation.disposition !== "remediate") {
      throw new MetadataError(`Runtime drift remediation plan '${this.remediationPlanId}' is not executable.`);
    }
    if (
      profileId !== remediation.profileId
      || fromVersion !== remediation.profileVersion
      || toVersion !== remediation.profileVersion
    ) {
      throw new MetadataError(
        `Runtime drift remediation plan '${this.remediationPlanId}' must execute against '${remediation.profileId}@${remediation.profileVersion}'.`,
      );
    }
    return clone(remediation.executionPlan);
  }
}

export function validateRuntimeDriftRemediationPlan(plan: RuntimeDriftRemediationPlan): void {
  if (plan.format !== "nublox-metaobject-runtime-drift-remediation" || plan.formatVersion !== 1) {
    throw new MetadataError("Unsupported runtime drift remediation plan format.");
  }
  if (
    !plan.remediationPlanId.trim()
    || !plan.assessmentId.trim()
    || !plan.baselineId.trim()
    || !plan.deploymentId.trim()
    || !plan.profileId.trim()
  ) {
    throw new MetadataError("Runtime drift remediation plan identity fields are required.");
  }
  if (!Number.isSafeInteger(plan.deploymentRevision) || plan.deploymentRevision < 1) {
    throw new MetadataError("Runtime drift remediation plan deploymentRevision must be a positive integer.");
  }
  if (!Number.isSafeInteger(plan.profileVersion) || plan.profileVersion < 1) {
    throw new MetadataError("Runtime drift remediation plan profileVersion must be a positive integer.");
  }
  const stepIds = new Set<string>();
  for (const step of plan.steps) {
    if (!step.id.trim() || stepIds.has(step.id)) {
      throw new MetadataError(`Runtime drift remediation plan contains an invalid or duplicate step id '${step.id}'.`);
    }
    stepIds.add(step.id);
    validateStepInput("persisted-plan", step);
  }
  for (const decision of plan.decisions) {
    if (!decision.probeId.trim() || !decision.message.trim()) {
      throw new MetadataError("Runtime drift remediation decision probeId and message are required.");
    }
    for (const stepId of decision.stepIds) {
      if (!stepIds.has(stepId)) throw new MetadataError(`Runtime drift remediation decision references unknown step '${stepId}'.`);
    }
    validateEvidence(`Runtime drift remediation decision '${decision.probeId}'`, decision.evidence);
  }
  if (plan.disposition === "remediate") {
    if (!plan.executionPlan || plan.steps.length === 0) {
      throw new MetadataError("Executable runtime drift remediation requires steps and an execution plan.");
    }
    if (plan.executionPlan.remediationPlanId !== plan.remediationPlanId) {
      throw new MetadataError("Runtime drift remediation execution plan identity mismatch.");
    }
  } else if (plan.executionPlan !== undefined) {
    throw new MetadataError("Non-executable runtime drift remediation cannot contain an execution plan.");
  }
  if (plan.disposition === "review" && !plan.requiresManualReview) {
    throw new MetadataError("Review runtime drift remediation must require manual review.");
  }
  if (!plan.createdAt.trim()) throw new MetadataError("Runtime drift remediation plan createdAt is required.");
}
