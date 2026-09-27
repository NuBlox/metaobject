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
  RuntimeDriftRemediationCaseRecord,
  RuntimeDriftRemediationCaseStore,
} from "./runtime-drift-remediation-closure.js";

export type RuntimePostureState =
  | "verified"
  | "warning"
  | "drifted"
  | "remediating"
  | "review"
  | "restored"
  | "stale";

export interface RuntimePostureSnapshot {
  readonly format: "nublox-metaobject-runtime-posture";
  readonly formatVersion: 1;
  readonly snapshotId: string;
  /** Caller-owned stable identity for a runtime/environment/deployment target. */
  readonly runtimeId: string;
  readonly state: RuntimePostureState;
  readonly profileId: string;
  readonly profileVersion: number;
  readonly deploymentId: string;
  readonly evidenceDeploymentRevision: number;
  readonly currentDeploymentRevision?: number;
  readonly attestationId: string;
  readonly baselineId: string;
  readonly assessmentId: string;
  readonly driftOutcome: RuntimeDeploymentDriftAssessment["outcome"];
  readonly remediationCaseId?: string;
  readonly remediationCaseStatus?: RuntimeDriftRemediationCaseRecord["status"];
  readonly message: string;
  readonly capturedAt: string;
}

export interface RuntimePostureSnapshotFilter {
  readonly runtimeId?: string;
  readonly state?: RuntimePostureState;
  readonly profileId?: string;
}

/** Create-only history of derived posture. Source evidence remains authoritative. */
export interface RuntimePostureSnapshotStore {
  get(snapshotId: string): Promise<RuntimePostureSnapshot | null>;
  list(filter?: RuntimePostureSnapshotFilter): Promise<readonly RuntimePostureSnapshot[]>;
  create(snapshot: RuntimePostureSnapshot): Promise<RuntimePostureSnapshot>;
}

const clone = <T>(value: T): T => structuredClone(value);

function compareSnapshots(left: RuntimePostureSnapshot, right: RuntimePostureSnapshot): number {
  return left.capturedAt.localeCompare(right.capturedAt) || left.snapshotId.localeCompare(right.snapshotId);
}

export class MemoryRuntimePostureSnapshotStore implements RuntimePostureSnapshotStore {
  readonly #records = new Map<string, RuntimePostureSnapshot>();

  async get(snapshotId: string): Promise<RuntimePostureSnapshot | null> {
    const record = this.#records.get(snapshotId);
    return record ? clone(record) : null;
  }

  async list(filter: RuntimePostureSnapshotFilter = {}): Promise<readonly RuntimePostureSnapshot[]> {
    return [...this.#records.values()]
      .filter((record) => filter.runtimeId === undefined || record.runtimeId === filter.runtimeId)
      .filter((record) => filter.state === undefined || record.state === filter.state)
      .filter((record) => filter.profileId === undefined || record.profileId === filter.profileId)
      .sort(compareSnapshots)
      .map(clone);
  }

  async create(snapshot: RuntimePostureSnapshot): Promise<RuntimePostureSnapshot> {
    validateRuntimePostureSnapshot(snapshot);
    if (this.#records.has(snapshot.snapshotId)) {
      throw new ConcurrencyError(`Runtime posture snapshot '${snapshot.snapshotId}' already exists.`);
    }
    this.#records.set(snapshot.snapshotId, clone(snapshot));
    return clone(snapshot);
  }
}

export interface RuntimePostureCaptureRequest {
  readonly snapshotId: string;
  readonly runtimeId: string;
  readonly baselineId: string;
  readonly assessmentId: string;
  readonly remediationCaseId?: string;
}

export type RuntimePostureClock = () => Date;

function deploymentMatchesEvidence(
  deployment: RuntimeDeploymentRecord | null,
  assessment: RuntimeDeploymentDriftAssessment,
): boolean {
  if (!deployment || deployment.status !== "completed" || assessment.deploymentCreatedAt === undefined) return false;
  return deployment.revision === assessment.deploymentRevision
    && deployment.createdAt === assessment.deploymentCreatedAt
    && deployment.steps.every((step) => step.status === "completed");
}

function assertEvidenceChain(
  attestation: RuntimeDeploymentAttestation,
  baseline: RuntimeDeploymentDriftBaseline,
  assessment: RuntimeDeploymentDriftAssessment,
): void {
  if (baseline.attestationId !== attestation.attestationId) {
    throw new MetadataError(`Runtime posture baseline '${baseline.baselineId}' does not reference attestation '${attestation.attestationId}'.`);
  }
  if (assessment.baselineId !== baseline.baselineId) {
    throw new MetadataError(`Runtime posture assessment '${assessment.assessmentId}' does not reference baseline '${baseline.baselineId}'.`);
  }
  if (
    attestation.deploymentId !== baseline.deploymentId
    || assessment.deploymentId !== baseline.deploymentId
    || attestation.profileId !== baseline.profileId
    || attestation.toProfileVersion !== baseline.profileVersion
  ) {
    throw new MetadataError("Runtime posture evidence chain contains inconsistent deployment/profile identity.");
  }
  if (
    attestation.deploymentRevision !== baseline.deploymentRevision
    || assessment.deploymentRevision !== baseline.deploymentRevision
  ) {
    throw new MetadataError("Runtime posture evidence chain contains inconsistent deployment revisions.");
  }
  if (
    attestation.deploymentCreatedAt === undefined
    || baseline.deploymentCreatedAt === undefined
    || assessment.deploymentCreatedAt === undefined
  ) {
    throw new MetadataError("Runtime posture requires deployment creation identity on attestation, baseline and assessment evidence.");
  }
  if (
    attestation.deploymentCreatedAt !== baseline.deploymentCreatedAt
    || assessment.deploymentCreatedAt !== baseline.deploymentCreatedAt
  ) {
    throw new MetadataError("Runtime posture evidence chain contains inconsistent deployment creation identity.");
  }
  if (attestation.outcome === "fail") {
    throw new MetadataError(`Failed attestation '${attestation.attestationId}' cannot support runtime posture.`);
  }
}

function baseState(assessment: RuntimeDeploymentDriftAssessment): {
  state: RuntimePostureState;
  message: string;
} {
  if (assessment.outcome === "clean") {
    return { state: "verified", message: "Latest verified runtime evidence is clean." };
  }
  if (assessment.outcome === "warning") {
    return { state: "warning", message: "Latest runtime assessment contains unverifiable evidence." };
  }
  return { state: "drifted", message: "Latest runtime assessment detected drift from the verified baseline." };
}

function caseState(
  remediationCase: RuntimeDriftRemediationCaseRecord,
  baseline: RuntimeDeploymentDriftBaseline,
  assessment: RuntimeDeploymentDriftAssessment,
): { state: RuntimePostureState; message: string } {
  if (remediationCase.status === "closed") {
    if (
      remediationCase.repairDeploymentId !== baseline.deploymentId
      || remediationCase.repairAttestationId !== baseline.attestationId
      || remediationCase.replacementBaselineId !== baseline.baselineId
      || remediationCase.closureAssessmentId !== assessment.assessmentId
    ) {
      throw new MetadataError(
        `Closed remediation case '${remediationCase.caseId}' does not close the supplied posture evidence chain.`,
      );
    }
    if (assessment.outcome !== "clean" || !assessment.checks.every((check) => check.status === "unchanged")) {
      throw new MetadataError(
        `Closed remediation case '${remediationCase.caseId}' does not have clean unchanged closure evidence.`,
      );
    }
    return { state: "restored", message: "Drift remediation is closed with independently verified clean replacement evidence." };
  }

  if (
    remediationCase.sourceAssessmentId !== assessment.assessmentId
    || remediationCase.sourceBaselineId !== baseline.baselineId
    || remediationCase.sourceDeploymentId !== baseline.deploymentId
  ) {
    throw new MetadataError(
      `Open remediation case '${remediationCase.caseId}' does not originate from the supplied assessment/baseline/deployment chain.`,
    );
  }
  if (remediationCase.status === "review") {
    return {
      state: "review",
      message: remediationCase.reviewReason ?? "Drift remediation requires manual review.",
    };
  }
  return { state: "remediating", message: `Drift remediation case is ${remediationCase.status}.` };
}

/**
 * Build immutable point-in-time posture snapshots from the authoritative M22–M25
 * evidence chain. The posture history is a projection only; it never rewrites
 * attestations, baselines, assessments, deployments or remediation cases.
 */
export class RuntimePostureCatalog {
  constructor(
    private readonly snapshots: RuntimePostureSnapshotStore,
    private readonly deployments: RuntimeDeploymentStore,
    private readonly attestations: RuntimeDeploymentAttestationStore,
    private readonly baselines: RuntimeDeploymentDriftBaselineStore,
    private readonly assessments: RuntimeDeploymentDriftAssessmentStore,
    private readonly remediationCases: RuntimeDriftRemediationCaseStore,
    private readonly clock: RuntimePostureClock = () => new Date(),
  ) {}

  async capture(request: RuntimePostureCaptureRequest): Promise<RuntimePostureSnapshot> {
    if (!request.snapshotId.trim()) throw new MetadataError("Runtime posture snapshot id is required.");
    if (!request.runtimeId.trim()) throw new MetadataError("Runtime posture runtimeId is required.");

    const baseline = await this.baselines.get(request.baselineId);
    if (!baseline) throw new MetadataError(`Unknown runtime posture baseline '${request.baselineId}'.`);
    const assessment = await this.assessments.get(request.assessmentId);
    if (!assessment) throw new MetadataError(`Unknown runtime posture assessment '${request.assessmentId}'.`);
    const attestation = await this.attestations.get(baseline.attestationId);
    if (!attestation) throw new MetadataError(`Unknown runtime posture attestation '${baseline.attestationId}'.`);
    assertEvidenceChain(attestation, baseline, assessment);

    let derived = baseState(assessment);
    let remediationCase: RuntimeDriftRemediationCaseRecord | null = null;

    if (request.remediationCaseId !== undefined) {
      remediationCase = await this.remediationCases.get(request.remediationCaseId);
      if (!remediationCase) throw new MetadataError(`Unknown runtime remediation case '${request.remediationCaseId}'.`);
      if (
        remediationCase.profileId !== baseline.profileId
        || remediationCase.profileVersion !== baseline.profileVersion
      ) {
        throw new MetadataError(`Runtime remediation case '${remediationCase.caseId}' does not match the posture profile.`);
      }
      derived = caseState(remediationCase, baseline, assessment);
    }

    // Read as late as possible so asynchronous evidence/case lookups cannot leave
    // a clean posture based on a deployment snapshot that changed meanwhile.
    const deployment = await this.deployments.get(baseline.deploymentId);

    // A stale deployment snapshot overrides ordinary clean/warning/drift posture.
    // Active remediation remains visible because the repair may intentionally be
    // changing external state while source evidence is no longer current.
    if (
      derived.state !== "remediating"
      && derived.state !== "review"
      && !deploymentMatchesEvidence(deployment, assessment)
    ) {
      derived = {
        state: "stale",
        message: "The persisted deployment snapshot changed after the supplied posture evidence was captured.",
      };
    }

    const snapshot: RuntimePostureSnapshot = {
      format: "nublox-metaobject-runtime-posture",
      formatVersion: 1,
      snapshotId: request.snapshotId,
      runtimeId: request.runtimeId,
      state: derived.state,
      profileId: baseline.profileId,
      profileVersion: baseline.profileVersion,
      deploymentId: baseline.deploymentId,
      evidenceDeploymentRevision: assessment.deploymentRevision,
      ...(deployment === null ? {} : { currentDeploymentRevision: deployment.revision }),
      attestationId: attestation.attestationId,
      baselineId: baseline.baselineId,
      assessmentId: assessment.assessmentId,
      driftOutcome: assessment.outcome,
      ...(remediationCase === null
        ? {}
        : {
            remediationCaseId: remediationCase.caseId,
            remediationCaseStatus: remediationCase.status,
          }),
      message: derived.message,
      capturedAt: this.clock().toISOString(),
    };
    return this.snapshots.create(snapshot);
  }

  async latest(runtimeId: string): Promise<RuntimePostureSnapshot | null> {
    if (!runtimeId.trim()) throw new MetadataError("Runtime posture runtimeId is required.");
    const history = await this.snapshots.list({ runtimeId });
    const latest = history.reduce<RuntimePostureSnapshot | null>(
      (current, snapshot) => current === null || compareSnapshots(snapshot, current) > 0 ? snapshot : current,
      null,
    );
    return latest === null ? null : clone(latest);
  }

  async history(runtimeId: string): Promise<readonly RuntimePostureSnapshot[]> {
    if (!runtimeId.trim()) throw new MetadataError("Runtime posture runtimeId is required.");
    return [...await this.snapshots.list({ runtimeId })].sort(compareSnapshots).map(clone);
  }
}

const validStates = new Set<RuntimePostureState>([
  "verified",
  "warning",
  "drifted",
  "remediating",
  "review",
  "restored",
  "stale",
]);

export function validateRuntimePostureSnapshot(snapshot: RuntimePostureSnapshot): void {
  if (snapshot.format !== "nublox-metaobject-runtime-posture" || snapshot.formatVersion !== 1) {
    throw new MetadataError("Unsupported runtime posture snapshot format.");
  }
  if (!snapshot.snapshotId.trim() || !snapshot.runtimeId.trim() || !snapshot.profileId.trim()) {
    throw new MetadataError("Runtime posture snapshot identity fields are required.");
  }
  if (!validStates.has(snapshot.state)) throw new MetadataError(`Invalid runtime posture state '${String(snapshot.state)}'.`);
  if (snapshot.driftOutcome !== "clean" && snapshot.driftOutcome !== "warning" && snapshot.driftOutcome !== "drift") {
    throw new MetadataError(`Invalid runtime posture drift outcome '${String(snapshot.driftOutcome)}'.`);
  }
  if (!snapshot.deploymentId.trim() || !snapshot.attestationId.trim() || !snapshot.baselineId.trim() || !snapshot.assessmentId.trim()) {
    throw new MetadataError("Runtime posture snapshot evidence references are required.");
  }
  if (!Number.isSafeInteger(snapshot.profileVersion) || snapshot.profileVersion < 1) {
    throw new MetadataError("Runtime posture snapshot profileVersion must be a positive integer.");
  }
  if (!Number.isSafeInteger(snapshot.evidenceDeploymentRevision) || snapshot.evidenceDeploymentRevision < 1) {
    throw new MetadataError("Runtime posture snapshot evidenceDeploymentRevision must be a positive integer.");
  }
  if (
    snapshot.currentDeploymentRevision !== undefined
    && (!Number.isSafeInteger(snapshot.currentDeploymentRevision) || snapshot.currentDeploymentRevision < 1)
  ) {
    throw new MetadataError("Runtime posture snapshot currentDeploymentRevision must be a positive integer.");
  }
  if (!snapshot.message.trim() || !snapshot.capturedAt.trim()) {
    throw new MetadataError("Runtime posture snapshot message and capturedAt are required.");
  }
}
