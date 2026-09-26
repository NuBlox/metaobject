import { ConcurrencyError, MetadataError } from "../errors/errors.js";
import type { RuntimeDeploymentRecord, RuntimeDeploymentStepEvidence, RuntimeDeploymentStore } from "./runtime-deployment-store.js";

export type RuntimeDeploymentVerificationOutcome = "pass" | "warn" | "fail";

export interface RuntimeDeploymentVerificationContext {
  readonly deployment: RuntimeDeploymentRecord;
}

export interface RuntimeDeploymentVerificationResult {
  readonly outcome: RuntimeDeploymentVerificationOutcome;
  readonly message?: string;
  readonly evidence?: RuntimeDeploymentStepEvidence;
}

export interface RuntimeDeploymentVerifier {
  readonly id: string;
  verify(context: RuntimeDeploymentVerificationContext): Promise<RuntimeDeploymentVerificationResult> | RuntimeDeploymentVerificationResult;
}

export interface RuntimeDeploymentAttestationCheck extends RuntimeDeploymentVerificationResult {
  readonly verifierId: string;
}

export interface RuntimeDeploymentAttestation {
  readonly format: "nublox-metaobject-runtime-deployment-attestation";
  readonly formatVersion: 1;
  readonly attestationId: string;
  readonly deploymentId: string;
  readonly deploymentRevision: number;
  readonly profileId: string;
  readonly fromProfileVersion: number;
  readonly toProfileVersion: number;
  readonly outcome: RuntimeDeploymentVerificationOutcome;
  readonly checks: readonly RuntimeDeploymentAttestationCheck[];
  /** Last journal sequence observed when the completed deployment was verified. */
  readonly journalSequence: number;
  readonly createdAt: string;
}

export interface RuntimeDeploymentAttestationFilter {
  readonly deploymentId?: string;
  readonly outcome?: RuntimeDeploymentVerificationOutcome;
}

/** Create-only store: attestations are immutable evidence, never updated in place. */
export interface RuntimeDeploymentAttestationStore {
  get(attestationId: string): Promise<RuntimeDeploymentAttestation | null>;
  list(filter?: RuntimeDeploymentAttestationFilter): Promise<readonly RuntimeDeploymentAttestation[]>;
  create(attestation: RuntimeDeploymentAttestation): Promise<RuntimeDeploymentAttestation>;
}

function clone<T>(value: T): T { return structuredClone(value); }

export class MemoryRuntimeDeploymentAttestationStore implements RuntimeDeploymentAttestationStore {
  readonly #records = new Map<string, RuntimeDeploymentAttestation>();

  async get(attestationId: string): Promise<RuntimeDeploymentAttestation | null> {
    const record = this.#records.get(attestationId);
    return record ? clone(record) : null;
  }

  async list(filter: RuntimeDeploymentAttestationFilter = {}): Promise<readonly RuntimeDeploymentAttestation[]> {
    return [...this.#records.values()]
      .filter((record) => filter.deploymentId === undefined || record.deploymentId === filter.deploymentId)
      .filter((record) => filter.outcome === undefined || record.outcome === filter.outcome)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.attestationId.localeCompare(right.attestationId))
      .map(clone);
  }

  async create(attestation: RuntimeDeploymentAttestation): Promise<RuntimeDeploymentAttestation> {
    validateRuntimeDeploymentAttestation(attestation);
    if (this.#records.has(attestation.attestationId)) {
      throw new ConcurrencyError(`Runtime deployment attestation '${attestation.attestationId}' already exists.`);
    }
    const stored = clone(attestation);
    this.#records.set(attestation.attestationId, stored);
    return clone(stored);
  }
}

export class RuntimeDeploymentVerifierRegistry {
  readonly #verifiers: RuntimeDeploymentVerifier[] = [];
  readonly #ids = new Set<string>();

  register(verifier: RuntimeDeploymentVerifier): this {
    if (!verifier.id.trim()) throw new MetadataError("Runtime deployment verifier id is required.");
    if (this.#ids.has(verifier.id)) throw new MetadataError(`Runtime deployment verifier '${verifier.id}' is already registered.`);
    this.#ids.add(verifier.id);
    this.#verifiers.push(verifier);
    return this;
  }

  list(): readonly RuntimeDeploymentVerifier[] { return [...this.#verifiers]; }
}

function validateResult(verifierId: string, result: RuntimeDeploymentVerificationResult): void {
  if (result.outcome !== "pass" && result.outcome !== "warn" && result.outcome !== "fail") {
    throw new MetadataError(`Runtime deployment verifier '${verifierId}' returned an invalid outcome.`);
  }
  if (result.outcome !== "pass" && !result.message?.trim()) {
    throw new MetadataError(`Runtime deployment verifier '${verifierId}' ${result.outcome} result requires a message.`);
  }
  if (result.evidence && !result.evidence.recordedAt.trim()) {
    throw new MetadataError(`Runtime deployment verifier '${verifierId}' evidence recordedAt is required.`);
  }
}

function overall(checks: readonly RuntimeDeploymentAttestationCheck[]): RuntimeDeploymentVerificationOutcome {
  if (checks.some((check) => check.outcome === "fail")) return "fail";
  if (checks.some((check) => check.outcome === "warn")) return "warn";
  return "pass";
}

export type RuntimeDeploymentAttestationClock = () => Date;

export class RuntimeDeploymentAttestationCatalog {
  constructor(
    private readonly deployments: RuntimeDeploymentStore,
    private readonly attestations: RuntimeDeploymentAttestationStore,
    private readonly verifiers: RuntimeDeploymentVerifierRegistry,
    private readonly clock: RuntimeDeploymentAttestationClock = () => new Date(),
  ) {}

  async verify(deploymentId: string, attestationId: string): Promise<RuntimeDeploymentAttestation> {
    if (!attestationId.trim()) throw new MetadataError("Runtime deployment attestation id is required.");
    const deployment = await this.deployments.get(deploymentId);
    if (!deployment) throw new MetadataError(`Unknown runtime deployment '${deploymentId}'.`);
    if (deployment.status !== "completed") {
      throw new MetadataError(`Runtime deployment '${deploymentId}' must be completed before attestation.`);
    }
    if (!deployment.steps.every((step) => step.status === "completed")) {
      throw new MetadataError(`Runtime deployment '${deploymentId}' contains incomplete step state.`);
    }
    const registered = this.verifiers.list();
    if (registered.length === 0) throw new MetadataError("At least one runtime deployment verifier is required.");

    const checks: RuntimeDeploymentAttestationCheck[] = [];
    for (const verifier of registered) {
      try {
        const result = await verifier.verify({ deployment: clone(deployment) });
        validateResult(verifier.id, result);
        checks.push({ verifierId: verifier.id, ...clone(result) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        checks.push({ verifierId: verifier.id, outcome: "fail", message: `Verifier failed closed: ${message}` });
      }
    }

    // Detect concurrent deployment mutation between verification and attestation creation.
    const current = await this.deployments.get(deploymentId);
    if (!current || current.revision !== deployment.revision) {
      throw new ConcurrencyError(`Runtime deployment '${deploymentId}' changed during attestation verification.`);
    }

    const attestation: RuntimeDeploymentAttestation = {
      format: "nublox-metaobject-runtime-deployment-attestation",
      formatVersion: 1,
      attestationId,
      deploymentId,
      deploymentRevision: deployment.revision,
      profileId: deployment.profileId,
      fromProfileVersion: deployment.fromProfileVersion,
      toProfileVersion: deployment.toProfileVersion,
      outcome: overall(checks),
      checks,
      journalSequence: deployment.journal?.at(-1)?.sequence ?? 0,
      createdAt: this.clock().toISOString(),
    };
    return this.attestations.create(attestation);
  }

  async get(attestationId: string): Promise<RuntimeDeploymentAttestation | null> {
    return this.attestations.get(attestationId);
  }

  async list(deploymentId?: string): Promise<readonly RuntimeDeploymentAttestation[]> {
    return this.attestations.list(deploymentId === undefined ? {} : { deploymentId });
  }
}

export function validateRuntimeDeploymentAttestation(attestation: RuntimeDeploymentAttestation): void {
  if (attestation.format !== "nublox-metaobject-runtime-deployment-attestation" || attestation.formatVersion !== 1) {
    throw new MetadataError("Unsupported runtime deployment attestation format.");
  }
  if (!attestation.attestationId.trim() || !attestation.deploymentId.trim() || !attestation.profileId.trim()) {
    throw new MetadataError("Runtime deployment attestation identity fields are required.");
  }
  if (!Number.isSafeInteger(attestation.deploymentRevision) || attestation.deploymentRevision < 1) {
    throw new MetadataError("Runtime deployment attestation deploymentRevision must be a positive integer.");
  }
  if (attestation.checks.length === 0) throw new MetadataError("Runtime deployment attestation requires at least one verifier check.");
  for (const check of attestation.checks) {
    if (!check.verifierId.trim()) throw new MetadataError("Runtime deployment attestation verifierId is required.");
    validateResult(check.verifierId, check);
  }
  if (overall(attestation.checks) !== attestation.outcome) {
    throw new MetadataError("Runtime deployment attestation overall outcome does not match verifier checks.");
  }
  if (!Number.isSafeInteger(attestation.journalSequence) || attestation.journalSequence < 0) {
    throw new MetadataError("Runtime deployment attestation journalSequence must be a non-negative integer.");
  }
  if (!attestation.createdAt.trim()) throw new MetadataError("Runtime deployment attestation createdAt is required.");
}
