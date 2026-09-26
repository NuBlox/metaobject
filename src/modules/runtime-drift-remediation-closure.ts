import { ConcurrencyError, MetadataError } from "../errors/errors.js";
import type {
  RuntimeDeploymentAttestation,
  RuntimeDeploymentAttestationStore,
} from "./runtime-deployment-attestation.js";
import type {
  RuntimeDeploymentDriftAssessment,
  RuntimeDeploymentDriftAssessmentStore,
  RuntimeDeploymentDriftBaseline,
  RuntimeDeploymentDriftBaselineStore,
} from "./runtime-deployment-drift.js";
import type { RuntimeDeploymentRecord, RuntimeDeploymentStore } from "./runtime-deployment-store.js";
import type {
  RuntimeDriftRemediationExecutionPlan,
  RuntimeDriftRemediationPlan,
  RuntimeDriftRemediationPlanStore,
} from "./runtime-drift-remediation.js";

export type RuntimeDriftRemediationCaseStatus =
  | "planned"
  | "deploying"
  | "verifying"
  | "closed"
  | "review";

export interface RuntimeDriftRemediationCaseRecord {
  readonly caseId: string;
  readonly status: RuntimeDriftRemediationCaseStatus;
  readonly revision: number;
  readonly remediationPlanId: string;
  readonly sourceAssessmentId: string;
  readonly sourceBaselineId: string;
  readonly sourceDeploymentId: string;
  readonly profileId: string;
  readonly profileVersion: number;
  readonly repairDeploymentId?: string;
  readonly repairAttestationId?: string;
  readonly replacementBaselineId?: string;
  readonly closureAssessmentId?: string;
  readonly reviewReason?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt?: string;
}

export interface RuntimeDriftRemediationCaseFilter {
  readonly status?: RuntimeDriftRemediationCaseStatus;
  readonly profileId?: string;
  readonly remediationPlanId?: string;
}

export interface RuntimeDriftRemediationCaseStore {
  get(caseId: string): Promise<RuntimeDriftRemediationCaseRecord | null>;
  list(filter?: RuntimeDriftRemediationCaseFilter): Promise<readonly RuntimeDriftRemediationCaseRecord[]>;
  save(
    record: RuntimeDriftRemediationCaseRecord,
    expectedRevision?: number,
  ): Promise<RuntimeDriftRemediationCaseRecord>;
}

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryRuntimeDriftRemediationCaseStore implements RuntimeDriftRemediationCaseStore {
  readonly #records = new Map<string, RuntimeDriftRemediationCaseRecord>();

  async get(caseId: string): Promise<RuntimeDriftRemediationCaseRecord | null> {
    const record = this.#records.get(caseId);
    return record ? clone(record) : null;
  }

  async list(filter: RuntimeDriftRemediationCaseFilter = {}): Promise<readonly RuntimeDriftRemediationCaseRecord[]> {
    return [...this.#records.values()]
      .filter((record) => filter.status === undefined || record.status === filter.status)
      .filter((record) => filter.profileId === undefined || record.profileId === filter.profileId)
      .filter((record) => filter.remediationPlanId === undefined || record.remediationPlanId === filter.remediationPlanId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.caseId.localeCompare(right.caseId))
      .map(clone);
  }

  async save(
    record: RuntimeDriftRemediationCaseRecord,
    expectedRevision?: number,
  ): Promise<RuntimeDriftRemediationCaseRecord> {
    validateRuntimeDriftRemediationCase(record);
    const current = this.#records.get(record.caseId);
    if (current) {
      if (expectedRevision === undefined) {
        throw new ConcurrencyError(`Runtime drift remediation case '${record.caseId}' already exists; expectedRevision is required.`);
      }
      if (current.revision !== expectedRevision) {
        throw new ConcurrencyError(
          `Runtime drift remediation case concurrency conflict for '${record.caseId}': expected revision ${expectedRevision}, found ${current.revision}.`,
        );
      }
      this.assertImmutableIdentity(current, record);
      if (current.status === "closed") {
        throw new MetadataError(`Closed runtime drift remediation case '${record.caseId}' is immutable.`);
      }
    } else if (expectedRevision !== undefined && expectedRevision !== 0) {
      throw new ConcurrencyError(
        `Runtime drift remediation case '${record.caseId}' does not exist; expected revision ${expectedRevision} cannot be satisfied.`,
      );
    }

    const stored = clone({
      ...record,
      revision: (current?.revision ?? 0) + 1,
      createdAt: current?.createdAt ?? record.createdAt,
    });
    this.#records.set(record.caseId, stored);
    return clone(stored);
  }

  private assertImmutableIdentity(
    current: RuntimeDriftRemediationCaseRecord,
    next: RuntimeDriftRemediationCaseRecord,
  ): void {
    if (
      current.remediationPlanId !== next.remediationPlanId
      || current.sourceAssessmentId !== next.sourceAssessmentId
      || current.sourceBaselineId !== next.sourceBaselineId
      || current.sourceDeploymentId !== next.sourceDeploymentId
      || current.profileId !== next.profileId
      || current.profileVersion !== next.profileVersion
    ) {
      throw new MetadataError(`Runtime drift remediation case '${current.caseId}' immutable identity cannot change.`);
    }
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonical(nested)]),
    );
  }
  return value;
}

function exactPlanMatch(
  actual: RuntimeDeploymentRecord["plan"],
  expected: RuntimeDriftRemediationExecutionPlan,
): boolean {
  return JSON.stringify(canonical(actual)) === JSON.stringify(canonical(expected));
}

function sameDeploymentIdentity(
  deployment: RuntimeDeploymentRecord,
  revision: number,
  createdAt?: string,
): boolean {
  return deployment.revision === revision
    && (createdAt === undefined || deployment.createdAt === createdAt);
}

function assertCompletedDeployment(deployment: RuntimeDeploymentRecord): void {
  if (deployment.status !== "completed" || !deployment.steps.every((step) => step.status === "completed")) {
    throw new MetadataError(`Runtime deployment '${deployment.deploymentId}' must be completed before remediation verification.`);
  }
}

export type RuntimeDriftRemediationCaseClock = () => Date;

/**
 * Durable closure workflow for one executable M24 remediation plan.
 *
 * A case can only close when the exact repair deployment completed, a passing
 * M22 attestation verified that deployment, a replacement M23 baseline was
 * established from that attestation, and an immediate M23 assessment of that
 * baseline is clean against the same unchanged completed deployment snapshot.
 */
export class RuntimeDriftRemediationCaseCatalog {
  constructor(
    private readonly cases: RuntimeDriftRemediationCaseStore,
    private readonly plans: RuntimeDriftRemediationPlanStore,
    private readonly deployments: RuntimeDeploymentStore,
    private readonly attestations: RuntimeDeploymentAttestationStore,
    private readonly baselines: RuntimeDeploymentDriftBaselineStore,
    private readonly assessments: RuntimeDeploymentDriftAssessmentStore,
    private readonly clock: RuntimeDriftRemediationCaseClock = () => new Date(),
  ) {}

  async create(caseId: string, remediationPlanId: string): Promise<RuntimeDriftRemediationCaseRecord> {
    if (!caseId.trim()) throw new MetadataError("Runtime drift remediation case id is required.");
    if (await this.cases.get(caseId)) throw new MetadataError(`Runtime drift remediation case '${caseId}' already exists.`);
    const plan = await this.requireExecutablePlan(remediationPlanId);
    const now = this.clock().toISOString();
    return this.cases.save({
      caseId,
      status: "planned",
      revision: 0,
      remediationPlanId: plan.remediationPlanId,
      sourceAssessmentId: plan.assessmentId,
      sourceBaselineId: plan.baselineId,
      sourceDeploymentId: plan.deploymentId,
      profileId: plan.profileId,
      profileVersion: plan.profileVersion,
      createdAt: now,
      updatedAt: now,
    });
  }

  async get(caseId: string): Promise<RuntimeDriftRemediationCaseRecord | null> {
    return this.cases.get(caseId);
  }

  async linkDeployment(
    caseId: string,
    repairDeploymentId: string,
    expectedRevision: number,
  ): Promise<RuntimeDriftRemediationCaseRecord> {
    const current = await this.requireCase(caseId);
    if (current.status !== "planned" && current.status !== "deploying") {
      throw new MetadataError(`Runtime drift remediation case '${caseId}' cannot link a deployment from status '${current.status}'.`);
    }
    if (current.repairDeploymentId !== undefined && current.repairDeploymentId !== repairDeploymentId) {
      throw new MetadataError(`Runtime drift remediation case '${caseId}' is already linked to deployment '${current.repairDeploymentId}'.`);
    }
    const plan = await this.requireExecutablePlan(current.remediationPlanId);
    const deployment = await this.deployments.get(repairDeploymentId);
    if (!deployment) throw new MetadataError(`Unknown runtime remediation deployment '${repairDeploymentId}'.`);
    if (
      deployment.profileId !== current.profileId
      || deployment.fromProfileVersion !== current.profileVersion
      || deployment.toProfileVersion !== current.profileVersion
    ) {
      throw new MetadataError(`Runtime remediation deployment '${repairDeploymentId}' does not target '${current.profileId}@${current.profileVersion}'.`);
    }
    if (!exactPlanMatch(deployment.plan, plan.executionPlan!)) {
      throw new MetadataError(`Runtime remediation deployment '${repairDeploymentId}' does not contain the exact immutable M24 execution plan.`);
    }
    const now = this.clock().toISOString();
    return this.cases.save({
      ...current,
      status: "deploying",
      repairDeploymentId,
      updatedAt: now,
    }, expectedRevision);
  }

  async linkAttestation(
    caseId: string,
    attestationId: string,
    expectedRevision: number,
  ): Promise<RuntimeDriftRemediationCaseRecord> {
    const current = await this.requireCase(caseId);
    if (current.status !== "deploying" && current.status !== "verifying") {
      throw new MetadataError(`Runtime drift remediation case '${caseId}' cannot verify from status '${current.status}'.`);
    }
    if (!current.repairDeploymentId) {
      throw new MetadataError(`Runtime drift remediation case '${caseId}' has no repair deployment.`);
    }
    const deployment = await this.requireCompletedRepairDeployment(current);
    const attestation = await this.attestations.get(attestationId);
    if (!attestation) throw new MetadataError(`Unknown runtime deployment attestation '${attestationId}'.`);
    this.assertAttestationMatches(attestation, deployment, current);

    const now = this.clock().toISOString();
    if (attestation.outcome !== "pass") {
      return this.cases.save({
        ...current,
        status: "review",
        repairAttestationId: attestationId,
        reviewReason: `Post-remediation attestation outcome '${attestation.outcome}' does not prove restoration.`,
        updatedAt: now,
      }, expectedRevision);
    }

    return this.cases.save({
      ...current,
      status: "verifying",
      repairAttestationId: attestationId,
      updatedAt: now,
    }, expectedRevision);
  }

  async close(
    caseId: string,
    replacementBaselineId: string,
    closureAssessmentId: string,
    expectedRevision: number,
  ): Promise<RuntimeDriftRemediationCaseRecord> {
    const current = await this.requireCase(caseId);
    if (current.status !== "verifying") {
      throw new MetadataError(`Runtime drift remediation case '${caseId}' must be verifying before closure.`);
    }
    if (!current.repairDeploymentId || !current.repairAttestationId) {
      throw new MetadataError(`Runtime drift remediation case '${caseId}' is missing repair verification artifacts.`);
    }

    const deployment = await this.requireCompletedRepairDeployment(current);
    const attestation = await this.attestations.get(current.repairAttestationId);
    if (!attestation || attestation.outcome !== "pass") {
      throw new MetadataError(`Runtime drift remediation case '${caseId}' requires a passing post-remediation attestation.`);
    }
    this.assertAttestationMatches(attestation, deployment, current);

    const baseline = await this.baselines.get(replacementBaselineId);
    if (!baseline) throw new MetadataError(`Unknown replacement runtime drift baseline '${replacementBaselineId}'.`);
    this.assertBaselineMatches(baseline, attestation, deployment, current);

    const assessment = await this.assessments.get(closureAssessmentId);
    if (!assessment) throw new MetadataError(`Unknown remediation closure assessment '${closureAssessmentId}'.`);
    this.assertAssessmentMatches(assessment, baseline, deployment);
    if (assessment.outcome !== "clean" || !assessment.checks.every((check) => check.status === "unchanged")) {
      throw new MetadataError(`Runtime drift remediation case '${caseId}' cannot close until the replacement baseline assesses cleanly.`);
    }

    // Final read closes the race between immutable evidence lookup and case closure.
    const finalDeployment = await this.deployments.get(deployment.deploymentId);
    if (
      !finalDeployment
      || !sameDeploymentIdentity(finalDeployment, deployment.revision, deployment.createdAt)
      || finalDeployment.status !== "completed"
    ) {
      throw new ConcurrencyError(`Runtime remediation deployment '${deployment.deploymentId}' changed during closure verification.`);
    }

    const now = this.clock().toISOString();
    return this.cases.save({
      ...current,
      status: "closed",
      replacementBaselineId,
      closureAssessmentId,
      closedAt: now,
      updatedAt: now,
    }, expectedRevision);
  }

  async requireReview(
    caseId: string,
    reason: string,
    expectedRevision: number,
  ): Promise<RuntimeDriftRemediationCaseRecord> {
    if (!reason.trim()) throw new MetadataError("Runtime drift remediation review reason is required.");
    const current = await this.requireCase(caseId);
    if (current.status === "closed") throw new MetadataError(`Closed runtime drift remediation case '${caseId}' cannot enter review.`);
    return this.cases.save({
      ...current,
      status: "review",
      reviewReason: reason,
      updatedAt: this.clock().toISOString(),
    }, expectedRevision);
  }

  private async requireExecutablePlan(remediationPlanId: string): Promise<RuntimeDriftRemediationPlan> {
    const plan = await this.plans.get(remediationPlanId);
    if (!plan) throw new MetadataError(`Unknown runtime drift remediation plan '${remediationPlanId}'.`);
    if (plan.disposition !== "remediate" || !plan.executionPlan || plan.steps.length === 0) {
      throw new MetadataError(`Runtime drift remediation plan '${remediationPlanId}' is not an executable remediation plan.`);
    }
    return plan;
  }

  private async requireCase(caseId: string): Promise<RuntimeDriftRemediationCaseRecord> {
    const record = await this.cases.get(caseId);
    if (!record) throw new MetadataError(`Unknown runtime drift remediation case '${caseId}'.`);
    return record;
  }

  private async requireCompletedRepairDeployment(
    current: RuntimeDriftRemediationCaseRecord,
  ): Promise<RuntimeDeploymentRecord> {
    const deployment = await this.deployments.get(current.repairDeploymentId!);
    if (!deployment) throw new MetadataError(`Unknown runtime remediation deployment '${current.repairDeploymentId}'.`);
    assertCompletedDeployment(deployment);
    const plan = await this.requireExecutablePlan(current.remediationPlanId);
    if (!exactPlanMatch(deployment.plan, plan.executionPlan!)) {
      throw new MetadataError(`Runtime remediation deployment '${deployment.deploymentId}' no longer matches the immutable M24 execution plan.`);
    }
    return deployment;
  }

  private assertAttestationMatches(
    attestation: RuntimeDeploymentAttestation,
    deployment: RuntimeDeploymentRecord,
    current: RuntimeDriftRemediationCaseRecord,
  ): void {
    if (
      attestation.deploymentId !== deployment.deploymentId
      || attestation.profileId !== current.profileId
      || attestation.fromProfileVersion !== current.profileVersion
      || attestation.toProfileVersion !== current.profileVersion
      || !sameDeploymentIdentity(deployment, attestation.deploymentRevision, attestation.deploymentCreatedAt)
    ) {
      throw new MetadataError(`Post-remediation attestation '${attestation.attestationId}' does not verify the exact repair deployment snapshot.`);
    }
  }

  private assertBaselineMatches(
    baseline: RuntimeDeploymentDriftBaseline,
    attestation: RuntimeDeploymentAttestation,
    deployment: RuntimeDeploymentRecord,
    current: RuntimeDriftRemediationCaseRecord,
  ): void {
    if (
      baseline.attestationId !== attestation.attestationId
      || baseline.deploymentId !== deployment.deploymentId
      || baseline.profileId !== current.profileId
      || baseline.profileVersion !== current.profileVersion
      || !sameDeploymentIdentity(deployment, baseline.deploymentRevision, baseline.deploymentCreatedAt)
    ) {
      throw new MetadataError(`Replacement runtime drift baseline '${baseline.baselineId}' is not bound to the verified repair deployment.`);
    }
  }

  private assertAssessmentMatches(
    assessment: RuntimeDeploymentDriftAssessment,
    baseline: RuntimeDeploymentDriftBaseline,
    deployment: RuntimeDeploymentRecord,
  ): void {
    if (
      assessment.baselineId !== baseline.baselineId
      || assessment.deploymentId !== deployment.deploymentId
      || !sameDeploymentIdentity(deployment, assessment.deploymentRevision, assessment.deploymentCreatedAt)
    ) {
      throw new MetadataError(`Remediation closure assessment '${assessment.assessmentId}' is not bound to the replacement baseline deployment snapshot.`);
    }
  }
}

export function validateRuntimeDriftRemediationCase(record: RuntimeDriftRemediationCaseRecord): void {
  if (!record.caseId.trim() || !record.remediationPlanId.trim() || !record.sourceAssessmentId.trim()) {
    throw new MetadataError("Runtime drift remediation case identity fields are required.");
  }
  if (!record.sourceBaselineId.trim() || !record.sourceDeploymentId.trim() || !record.profileId.trim()) {
    throw new MetadataError("Runtime drift remediation case source/profile fields are required.");
  }
  if (!Number.isSafeInteger(record.profileVersion) || record.profileVersion < 1) {
    throw new MetadataError("Runtime drift remediation case profileVersion must be a positive integer.");
  }
  if (!Number.isSafeInteger(record.revision) || record.revision < 0) {
    throw new MetadataError("Runtime drift remediation case revision must be a non-negative integer.");
  }
  if (!record.createdAt.trim() || !record.updatedAt.trim()) {
    throw new MetadataError("Runtime drift remediation case timestamps are required.");
  }
  if (record.status !== "planned" && !record.repairDeploymentId?.trim()) {
    throw new MetadataError(`Runtime drift remediation case status '${record.status}' requires a repair deployment.`);
  }
  if ((record.status === "verifying" || record.status === "closed") && !record.repairAttestationId?.trim()) {
    throw new MetadataError(`Runtime drift remediation case status '${record.status}' requires a repair attestation.`);
  }
  if (record.status === "closed") {
    if (!record.replacementBaselineId?.trim() || !record.closureAssessmentId?.trim() || !record.closedAt?.trim()) {
      throw new MetadataError("Closed runtime drift remediation case requires replacement baseline, closure assessment and closedAt.");
    }
  }
  if (record.status === "review" && !record.reviewReason?.trim()) {
    throw new MetadataError("Review runtime drift remediation case requires a review reason.");
  }
}
