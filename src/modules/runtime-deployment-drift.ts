import { ConcurrencyError, MetadataError } from "../errors/errors.js";
import type {
  RuntimeDeploymentAttestation,
  RuntimeDeploymentAttestationStore,
} from "./runtime-deployment-attestation.js";
import type {
  RuntimeDeploymentRecord,
  RuntimeDeploymentStepEvidence,
  RuntimeDeploymentStore,
} from "./runtime-deployment-store.js";

export interface RuntimeDeploymentDriftProbeContext {
  readonly deployment: RuntimeDeploymentRecord;
  readonly attestation: RuntimeDeploymentAttestation;
}

export interface RuntimeDeploymentDriftProbeResult {
  readonly fingerprint: string;
  readonly message?: string;
  readonly evidence?: RuntimeDeploymentStepEvidence;
}

export interface RuntimeDeploymentDriftProbe {
  readonly id: string;
  inspect(context: RuntimeDeploymentDriftProbeContext): Promise<RuntimeDeploymentDriftProbeResult> | RuntimeDeploymentDriftProbeResult;
}

export class RuntimeDeploymentDriftProbeRegistry {
  readonly #probes: RuntimeDeploymentDriftProbe[] = [];
  readonly #ids = new Set<string>();

  register(probe: RuntimeDeploymentDriftProbe): this {
    if (!probe.id.trim()) throw new MetadataError("Runtime deployment drift probe id is required.");
    if (this.#ids.has(probe.id)) throw new MetadataError(`Runtime deployment drift probe '${probe.id}' is already registered.`);
    this.#ids.add(probe.id);
    this.#probes.push(probe);
    return this;
  }

  list(): readonly RuntimeDeploymentDriftProbe[] { return [...this.#probes]; }
}

export interface RuntimeDeploymentDriftBaselineFingerprint extends RuntimeDeploymentDriftProbeResult {
  readonly probeId: string;
}

export interface RuntimeDeploymentDriftBaseline {
  readonly format: "nublox-metaobject-runtime-drift-baseline";
  readonly formatVersion: 1;
  readonly baselineId: string;
  readonly attestationId: string;
  readonly deploymentId: string;
  readonly deploymentRevision: number;
  readonly deploymentCreatedAt?: string;
  readonly profileId: string;
  readonly profileVersion: number;
  readonly fingerprints: readonly RuntimeDeploymentDriftBaselineFingerprint[];
  readonly createdAt: string;
}

export type RuntimeDeploymentDriftCheckStatus = "unchanged" | "changed" | "unverifiable";
export type RuntimeDeploymentDriftOutcome = "clean" | "warning" | "drift";

export interface RuntimeDeploymentDriftCheck {
  readonly probeId: string;
  readonly status: RuntimeDeploymentDriftCheckStatus;
  readonly baselineFingerprint?: string;
  readonly currentFingerprint?: string;
  readonly message?: string;
  readonly evidence?: RuntimeDeploymentStepEvidence;
}

export interface RuntimeDeploymentDriftAssessment {
  readonly format: "nublox-metaobject-runtime-drift-assessment";
  readonly formatVersion: 1;
  readonly assessmentId: string;
  readonly baselineId: string;
  readonly deploymentId: string;
  readonly deploymentRevision: number;
  readonly deploymentCreatedAt?: string;
  readonly outcome: RuntimeDeploymentDriftOutcome;
  readonly checks: readonly RuntimeDeploymentDriftCheck[];
  readonly createdAt: string;
}

export interface RuntimeDeploymentDriftBaselineStore {
  get(baselineId: string): Promise<RuntimeDeploymentDriftBaseline | null>;
  create(baseline: RuntimeDeploymentDriftBaseline): Promise<RuntimeDeploymentDriftBaseline>;
}

export interface RuntimeDeploymentDriftAssessmentStore {
  get(assessmentId: string): Promise<RuntimeDeploymentDriftAssessment | null>;
  list(baselineId?: string): Promise<readonly RuntimeDeploymentDriftAssessment[]>;
  create(assessment: RuntimeDeploymentDriftAssessment): Promise<RuntimeDeploymentDriftAssessment>;
}

const clone = <T>(value: T): T => structuredClone(value);

function sameDeploymentSnapshot(left: RuntimeDeploymentRecord, right: RuntimeDeploymentRecord): boolean {
  return left.revision === right.revision
    && left.createdAt === right.createdAt
    && left.profileId === right.profileId
    && left.fromProfileVersion === right.fromProfileVersion
    && left.toProfileVersion === right.toProfileVersion
    && (left.journal?.at(-1)?.sequence ?? 0) === (right.journal?.at(-1)?.sequence ?? 0)
    && left.plan.profileId === right.plan.profileId
    && left.plan.fromProfileVersion === right.plan.fromProfileVersion
    && left.plan.toProfileVersion === right.plan.toProfileVersion
    && left.plan.steps.length === right.plan.steps.length;
}

export class MemoryRuntimeDeploymentDriftBaselineStore implements RuntimeDeploymentDriftBaselineStore {
  readonly #records = new Map<string, RuntimeDeploymentDriftBaseline>();
  async get(id: string): Promise<RuntimeDeploymentDriftBaseline | null> {
    const record = this.#records.get(id);
    return record ? clone(record) : null;
  }
  async create(record: RuntimeDeploymentDriftBaseline): Promise<RuntimeDeploymentDriftBaseline> {
    validateRuntimeDeploymentDriftBaseline(record);
    if (this.#records.has(record.baselineId)) throw new ConcurrencyError(`Runtime drift baseline '${record.baselineId}' already exists.`);
    this.#records.set(record.baselineId, clone(record));
    return clone(record);
  }
}

export class MemoryRuntimeDeploymentDriftAssessmentStore implements RuntimeDeploymentDriftAssessmentStore {
  readonly #records = new Map<string, RuntimeDeploymentDriftAssessment>();
  async get(id: string): Promise<RuntimeDeploymentDriftAssessment | null> {
    const record = this.#records.get(id);
    return record ? clone(record) : null;
  }
  async list(baselineId?: string): Promise<readonly RuntimeDeploymentDriftAssessment[]> {
    return [...this.#records.values()]
      .filter((record) => baselineId === undefined || record.baselineId === baselineId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.assessmentId.localeCompare(b.assessmentId))
      .map(clone);
  }
  async create(record: RuntimeDeploymentDriftAssessment): Promise<RuntimeDeploymentDriftAssessment> {
    validateRuntimeDeploymentDriftAssessment(record);
    if (this.#records.has(record.assessmentId)) throw new ConcurrencyError(`Runtime drift assessment '${record.assessmentId}' already exists.`);
    this.#records.set(record.assessmentId, clone(record));
    return clone(record);
  }
}

function assertProbeResult(probeId: string, result: RuntimeDeploymentDriftProbeResult): void {
  if (!result.fingerprint.trim()) throw new MetadataError(`Runtime deployment drift probe '${probeId}' returned an empty fingerprint.`);
  if (result.evidence && !result.evidence.recordedAt.trim()) {
    throw new MetadataError(`Runtime deployment drift probe '${probeId}' evidence recordedAt is required.`);
  }
}

function assessmentOutcome(checks: readonly RuntimeDeploymentDriftCheck[]): RuntimeDeploymentDriftOutcome {
  if (checks.some((check) => check.status === "changed")) return "drift";
  if (checks.some((check) => check.status === "unverifiable")) return "warning";
  return "clean";
}

export type RuntimeDeploymentDriftClock = () => Date;

export class RuntimeDeploymentDriftCatalog {
  constructor(
    private readonly deployments: RuntimeDeploymentStore,
    private readonly attestations: RuntimeDeploymentAttestationStore,
    private readonly baselines: RuntimeDeploymentDriftBaselineStore,
    private readonly assessments: RuntimeDeploymentDriftAssessmentStore,
    private readonly probes: RuntimeDeploymentDriftProbeRegistry,
    private readonly clock: RuntimeDeploymentDriftClock = () => new Date(),
  ) {}

  async createBaseline(attestationId: string, baselineId: string): Promise<RuntimeDeploymentDriftBaseline> {
    if (!baselineId.trim()) throw new MetadataError("Runtime drift baseline id is required.");
    const attestation = await this.attestations.get(attestationId);
    if (!attestation) throw new MetadataError(`Unknown runtime deployment attestation '${attestationId}'.`);
    if (attestation.outcome === "fail") throw new MetadataError(`Failed attestation '${attestationId}' cannot establish a drift baseline.`);
    const deployment = await this.requireCompletedDeployment(attestation.deploymentId);
    if (
      deployment.revision !== attestation.deploymentRevision
      || (attestation.deploymentCreatedAt !== undefined && deployment.createdAt !== attestation.deploymentCreatedAt)
    ) {
      throw new ConcurrencyError(`Runtime deployment '${deployment.deploymentId}' changed after attestation '${attestationId}'.`);
    }
    const registered = this.probes.list();
    if (registered.length === 0) throw new MetadataError("At least one runtime deployment drift probe is required.");

    const fingerprints: RuntimeDeploymentDriftBaselineFingerprint[] = [];
    for (const probe of registered) {
      const result = await probe.inspect({ deployment: clone(deployment), attestation: clone(attestation) });
      assertProbeResult(probe.id, result);
      fingerprints.push({ probeId: probe.id, ...clone(result) });
    }

    const current = await this.deployments.get(deployment.deploymentId);
    if (!current || !sameDeploymentSnapshot(current, deployment)) {
      throw new ConcurrencyError(`Runtime deployment '${deployment.deploymentId}' changed during drift baseline inspection.`);
    }

    const baseline: RuntimeDeploymentDriftBaseline = {
      format: "nublox-metaobject-runtime-drift-baseline",
      formatVersion: 1,
      baselineId,
      attestationId,
      deploymentId: deployment.deploymentId,
      deploymentRevision: deployment.revision,
      deploymentCreatedAt: deployment.createdAt,
      profileId: deployment.profileId,
      profileVersion: deployment.toProfileVersion,
      fingerprints,
      createdAt: this.clock().toISOString(),
    };
    return this.baselines.create(baseline);
  }

  async assess(baselineId: string, assessmentId: string): Promise<RuntimeDeploymentDriftAssessment> {
    if (!assessmentId.trim()) throw new MetadataError("Runtime drift assessment id is required.");
    const baseline = await this.baselines.get(baselineId);
    if (!baseline) throw new MetadataError(`Unknown runtime drift baseline '${baselineId}'.`);
    const attestation = await this.attestations.get(baseline.attestationId);
    if (!attestation) throw new MetadataError(`Unknown baseline attestation '${baseline.attestationId}'.`);
    const deployment = await this.requireCompletedDeployment(baseline.deploymentId);
    const currentById = new Map(this.probes.list().map((probe) => [probe.id, probe]));
    const checks: RuntimeDeploymentDriftCheck[] = [];

    if (
      deployment.revision !== baseline.deploymentRevision
      || (baseline.deploymentCreatedAt !== undefined && deployment.createdAt !== baseline.deploymentCreatedAt)
    ) {
      checks.push({
        probeId: "$deployment-revision",
        status: "changed",
        baselineFingerprint: `${baseline.deploymentCreatedAt ?? "legacy"}:${baseline.deploymentRevision}`,
        currentFingerprint: `${deployment.createdAt}:${deployment.revision}`,
        message: "The persisted completed deployment record changed after the baseline was established.",
      });
    }

    for (const expected of baseline.fingerprints) {
      const probe = currentById.get(expected.probeId);
      if (!probe) {
        checks.push({ probeId: expected.probeId, status: "unverifiable", baselineFingerprint: expected.fingerprint, message: "The baseline probe is no longer registered." });
        continue;
      }
      try {
        const result = await probe.inspect({ deployment: clone(deployment), attestation: clone(attestation) });
        assertProbeResult(probe.id, result);
        checks.push({
          probeId: probe.id,
          status: result.fingerprint === expected.fingerprint ? "unchanged" : "changed",
          baselineFingerprint: expected.fingerprint,
          currentFingerprint: result.fingerprint,
          ...(result.message === undefined ? {} : { message: result.message }),
          ...(result.evidence === undefined ? {} : { evidence: clone(result.evidence) }),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        checks.push({ probeId: expected.probeId, status: "unverifiable", baselineFingerprint: expected.fingerprint, message: `Probe failed: ${message}` });
      }
    }

    const current = await this.deployments.get(deployment.deploymentId);
    if (!current || !sameDeploymentSnapshot(current, deployment)) {
      throw new ConcurrencyError(`Runtime deployment '${deployment.deploymentId}' changed during drift assessment.`);
    }

    const assessment: RuntimeDeploymentDriftAssessment = {
      format: "nublox-metaobject-runtime-drift-assessment",
      formatVersion: 1,
      assessmentId,
      baselineId,
      deploymentId: deployment.deploymentId,
      deploymentRevision: deployment.revision,
      deploymentCreatedAt: deployment.createdAt,
      outcome: assessmentOutcome(checks),
      checks,
      createdAt: this.clock().toISOString(),
    };
    return this.assessments.create(assessment);
  }

  private async requireCompletedDeployment(deploymentId: string): Promise<RuntimeDeploymentRecord> {
    const deployment = await this.deployments.get(deploymentId);
    if (!deployment) throw new MetadataError(`Unknown runtime deployment '${deploymentId}'.`);
    if (deployment.status !== "completed" || !deployment.steps.every((step) => step.status === "completed")) {
      throw new MetadataError(`Runtime deployment '${deploymentId}' must be completed before drift inspection.`);
    }
    return deployment;
  }
}

export function validateRuntimeDeploymentDriftBaseline(record: RuntimeDeploymentDriftBaseline): void {
  if (record.format !== "nublox-metaobject-runtime-drift-baseline" || record.formatVersion !== 1) throw new MetadataError("Unsupported runtime drift baseline format.");
  if (!record.baselineId.trim() || !record.attestationId.trim() || !record.deploymentId.trim() || !record.profileId.trim()) throw new MetadataError("Runtime drift baseline identity fields are required.");
  if (record.deploymentCreatedAt !== undefined && !record.deploymentCreatedAt.trim()) throw new MetadataError("Runtime drift baseline deploymentCreatedAt cannot be empty.");
  if (record.fingerprints.length === 0) throw new MetadataError("Runtime drift baseline requires at least one fingerprint.");
  const ids = new Set<string>();
  for (const fingerprint of record.fingerprints) {
    if (!fingerprint.probeId.trim() || !fingerprint.fingerprint.trim()) throw new MetadataError("Runtime drift baseline probe id and fingerprint are required.");
    if (ids.has(fingerprint.probeId)) throw new MetadataError(`Duplicate runtime drift baseline probe '${fingerprint.probeId}'.`);
    ids.add(fingerprint.probeId);
  }
}

export function validateRuntimeDeploymentDriftAssessment(record: RuntimeDeploymentDriftAssessment): void {
  if (record.format !== "nublox-metaobject-runtime-drift-assessment" || record.formatVersion !== 1) throw new MetadataError("Unsupported runtime drift assessment format.");
  if (!record.assessmentId.trim() || !record.baselineId.trim() || !record.deploymentId.trim()) throw new MetadataError("Runtime drift assessment identity fields are required.");
  if (record.deploymentCreatedAt !== undefined && !record.deploymentCreatedAt.trim()) throw new MetadataError("Runtime drift assessment deploymentCreatedAt cannot be empty.");
  if (record.checks.length === 0) throw new MetadataError("Runtime drift assessment requires at least one check.");
  if (assessmentOutcome(record.checks) !== record.outcome) throw new MetadataError("Runtime drift assessment outcome does not match its checks.");
  if (!record.createdAt.trim()) throw new MetadataError("Runtime drift assessment createdAt is required.");
}
