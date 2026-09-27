import { ConcurrencyError, MetadataError } from "../errors/errors.js";
import type { RuntimeFleetFairDispatchRecord } from "./runtime-fleet-convergence-fair-dispatch.js";
import { validateRuntimeFleetFairDispatchRecord } from "./runtime-fleet-convergence-fair-dispatch.js";
import type { RuntimeFleetFairReservationRecord } from "./runtime-fleet-convergence-fair-reservation.js";
import { validateRuntimeFleetFairReservationRecord } from "./runtime-fleet-convergence-fair-reservation.js";
import type {
  RuntimeFleetHandoffRecoveryChainAttestationRecord,
} from "./runtime-fleet-convergence-handoff-recovery-attestation.js";
import {
  validateRuntimeFleetHandoffRecoveryChainAttestationRecord,
} from "./runtime-fleet-convergence-handoff-recovery-attestation.js";
import type { RuntimeFleetHandoffRecoveryAudit } from "./runtime-fleet-convergence-handoff-recovery.js";
import { validateRuntimeFleetHandoffRecoveryAudit } from "./runtime-fleet-convergence-handoff-recovery.js";
import type { RuntimeFleetHandoffRecoveryResolutionRecord } from "./runtime-fleet-convergence-handoff-resolution.js";
import { validateRuntimeFleetHandoffRecoveryResolutionRecord } from "./runtime-fleet-convergence-handoff-resolution.js";
import type { RuntimeFleetHandoffResolutionExecutionRecord } from "./runtime-fleet-convergence-handoff-resolution-execution.js";
import { validateRuntimeFleetHandoffResolutionExecutionRecord } from "./runtime-fleet-convergence-handoff-resolution-execution.js";

export type RuntimeFleetHandoffRecoveryEvidenceAlgorithm = "SHA-256";
export type RuntimeFleetHandoffRecoveryEvidenceCanonicalization = "nublox-json-canonical-v1";
export type RuntimeFleetHandoffRecoveryEvidenceComponent =
  | "audit"
  | "resolution"
  | "execution"
  | "reservation"
  | "admission"
  | "attestation";

export interface RuntimeFleetHandoffRecoveryEvidenceComponentDigest {
  readonly component: RuntimeFleetHandoffRecoveryEvidenceComponent;
  readonly present: boolean;
  readonly digest?: string;
}

export interface RuntimeFleetHandoffRecoveryEvidenceIntegrityRecord {
  readonly format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-integrity";
  readonly formatVersion: 1;
  readonly integrityId: string;
  readonly attestationId: string;
  readonly recoveryId: string;
  readonly resolutionId: string;
  readonly executionId: string;
  readonly reservationId: string;
  readonly admissionId: string;
  readonly algorithm: RuntimeFleetHandoffRecoveryEvidenceAlgorithm;
  readonly canonicalization: RuntimeFleetHandoffRecoveryEvidenceCanonicalization;
  readonly components: readonly RuntimeFleetHandoffRecoveryEvidenceComponentDigest[];
  readonly rootDigest: string;
  readonly createdAt: string;
}

export interface RuntimeFleetHandoffRecoveryEvidenceIntegrityFilter {
  readonly attestationId?: string;
  readonly recoveryId?: string;
  readonly executionId?: string;
}

export interface RuntimeFleetHandoffRecoveryEvidenceIntegrityStore {
  get(integrityId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceIntegrityRecord | null>;
  list(
    filter?: RuntimeFleetHandoffRecoveryEvidenceIntegrityFilter,
  ): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceIntegrityRecord[]>;
  create(
    record: RuntimeFleetHandoffRecoveryEvidenceIntegrityRecord,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceIntegrityRecord>;
}

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryRuntimeFleetHandoffRecoveryEvidenceIntegrityStore
implements RuntimeFleetHandoffRecoveryEvidenceIntegrityStore {
  readonly #records = new Map<string, RuntimeFleetHandoffRecoveryEvidenceIntegrityRecord>();

  async get(integrityId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceIntegrityRecord | null> {
    const record = this.#records.get(integrityId);
    return record ? clone(record) : null;
  }

  async list(
    filter: RuntimeFleetHandoffRecoveryEvidenceIntegrityFilter = {},
  ): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceIntegrityRecord[]> {
    return [...this.#records.values()]
      .filter((record) => filter.attestationId === undefined || record.attestationId === filter.attestationId)
      .filter((record) => filter.recoveryId === undefined || record.recoveryId === filter.recoveryId)
      .filter((record) => filter.executionId === undefined || record.executionId === filter.executionId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.integrityId.localeCompare(right.integrityId))
      .map(clone);
  }

  async create(
    record: RuntimeFleetHandoffRecoveryEvidenceIntegrityRecord,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceIntegrityRecord> {
    validateRuntimeFleetHandoffRecoveryEvidenceIntegrityRecord(record);
    if (this.#records.has(record.integrityId)) {
      throw new ConcurrencyError(`Runtime fleet handoff recovery evidence integrity '${record.integrityId}' already exists.`);
    }
    const stored = clone(record);
    this.#records.set(stored.integrityId, stored);
    return clone(stored);
  }
}

export interface RuntimeFleetHandoffRecoveryEvidenceAttestationSource {
  get(attestationId: string): Promise<RuntimeFleetHandoffRecoveryChainAttestationRecord | null>;
}
export interface RuntimeFleetHandoffRecoveryEvidenceAuditSource {
  get(recoveryId: string): Promise<RuntimeFleetHandoffRecoveryAudit | null>;
}
export interface RuntimeFleetHandoffRecoveryEvidenceResolutionSource {
  get(resolutionId: string): Promise<RuntimeFleetHandoffRecoveryResolutionRecord | null>;
}
export interface RuntimeFleetHandoffRecoveryEvidenceExecutionSource {
  get(executionId: string): Promise<RuntimeFleetHandoffResolutionExecutionRecord | null>;
}
export interface RuntimeFleetHandoffRecoveryEvidenceReservationSource {
  get(reservationId: string): Promise<RuntimeFleetFairReservationRecord | null>;
}
export interface RuntimeFleetHandoffRecoveryEvidenceAdmissionSource {
  get(admissionId: string): Promise<RuntimeFleetFairDispatchRecord | null>;
}

export interface RuntimeFleetHandoffRecoveryEvidenceIntegrityRequest {
  readonly integrityId: string;
  readonly attestationId: string;
}

export interface RuntimeFleetHandoffRecoveryEvidenceVerification {
  readonly integrityId: string;
  readonly valid: boolean;
  readonly expectedRootDigest: string;
  readonly actualRootDigest: string;
  readonly mismatchedComponents: readonly RuntimeFleetHandoffRecoveryEvidenceComponent[];
  readonly verifiedAt: string;
}

export type RuntimeFleetHandoffRecoveryEvidenceIntegrityClock = () => Date;

/**
 * Create and later verify a deterministic SHA-256 integrity snapshot over the
 * complete M44 -> M48 recovery evidence chain. This provides tamper evidence;
 * trust/key management and digital signatures remain outside this package.
 */
export class RuntimeFleetHandoffRecoveryEvidenceIntegrityCatalog {
  constructor(
    private readonly attestations: RuntimeFleetHandoffRecoveryEvidenceAttestationSource,
    private readonly audits: RuntimeFleetHandoffRecoveryEvidenceAuditSource,
    private readonly resolutions: RuntimeFleetHandoffRecoveryEvidenceResolutionSource,
    private readonly executions: RuntimeFleetHandoffRecoveryEvidenceExecutionSource,
    private readonly reservations: RuntimeFleetHandoffRecoveryEvidenceReservationSource,
    private readonly admissions: RuntimeFleetHandoffRecoveryEvidenceAdmissionSource,
    private readonly integrity: RuntimeFleetHandoffRecoveryEvidenceIntegrityStore,
    private readonly clock: RuntimeFleetHandoffRecoveryEvidenceIntegrityClock = () => new Date(),
  ) {}

  async create(
    request: RuntimeFleetHandoffRecoveryEvidenceIntegrityRequest,
  ): Promise<RuntimeFleetHandoffRecoveryEvidenceIntegrityRecord> {
    assertText(request.integrityId, "integrityId");
    assertText(request.attestationId, "attestationId");
    if (await this.integrity.get(request.integrityId)) {
      throw new ConcurrencyError(`Runtime fleet handoff recovery evidence integrity '${request.integrityId}' already exists.`);
    }

    const snapshot = await this.loadSnapshot(request.attestationId);
    assertSnapshotMatchesAttestation(snapshot);
    const components = await digestSnapshot(snapshot);
    const rootDigest = await digestRoot(components);
    const record: RuntimeFleetHandoffRecoveryEvidenceIntegrityRecord = {
      format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-integrity",
      formatVersion: 1,
      integrityId: request.integrityId,
      attestationId: snapshot.attestation.attestationId,
      recoveryId: snapshot.audit.recoveryId,
      resolutionId: snapshot.resolution.resolutionId,
      executionId: snapshot.execution.executionId,
      reservationId: snapshot.reservation.reservationId,
      admissionId: snapshot.attestation.admissionId,
      algorithm: "SHA-256",
      canonicalization: "nublox-json-canonical-v1",
      components,
      rootDigest,
      createdAt: this.clock().toISOString(),
    };
    return this.integrity.create(record);
  }

  async verify(integrityId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceVerification> {
    assertText(integrityId, "integrityId");
    const record = await this.integrity.get(integrityId);
    if (!record) throw new MetadataError(`Unknown runtime fleet handoff recovery evidence integrity '${integrityId}'.`);
    validateRuntimeFleetHandoffRecoveryEvidenceIntegrityRecord(record);

    const snapshot = await this.loadSnapshot(record.attestationId);
    const actualComponents = await digestSnapshot(snapshot);
    const actualRootDigest = await digestRoot(actualComponents);
    const expected = new Map(record.components.map((component) => [component.component, component] as const));
    const mismatchedComponents = actualComponents
      .filter((actual) => {
        const prior = expected.get(actual.component);
        return prior === undefined || prior.present !== actual.present || prior.digest !== actual.digest;
      })
      .map((component) => component.component);

    return {
      integrityId: record.integrityId,
      valid: mismatchedComponents.length === 0 && actualRootDigest === record.rootDigest,
      expectedRootDigest: record.rootDigest,
      actualRootDigest,
      mismatchedComponents,
      verifiedAt: this.clock().toISOString(),
    };
  }

  async get(integrityId: string): Promise<RuntimeFleetHandoffRecoveryEvidenceIntegrityRecord | null> {
    assertText(integrityId, "integrityId");
    return this.integrity.get(integrityId);
  }

  async history(
    filter: RuntimeFleetHandoffRecoveryEvidenceIntegrityFilter = {},
  ): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceIntegrityRecord[]> {
    return this.integrity.list(filter);
  }

  private async loadSnapshot(attestationId: string): Promise<EvidenceSnapshot> {
    const attestation = await this.attestations.get(attestationId);
    if (!attestation) throw new MetadataError(`Unknown M48 recovery chain attestation '${attestationId}'.`);
    validateRuntimeFleetHandoffRecoveryChainAttestationRecord(attestation);

    const audit = await this.audits.get(attestation.recoveryId);
    if (!audit) throw new MetadataError(`Unknown M44 recovery audit '${attestation.recoveryId}'.`);
    validateRuntimeFleetHandoffRecoveryAudit(audit);

    const resolution = await this.resolutions.get(attestation.resolutionId);
    if (!resolution) throw new MetadataError(`Unknown M45 resolution '${attestation.resolutionId}'.`);
    validateRuntimeFleetHandoffRecoveryResolutionRecord(resolution);

    const execution = await this.executions.get(attestation.executionId);
    if (!execution) throw new MetadataError(`Unknown M46/M47 execution '${attestation.executionId}'.`);
    validateRuntimeFleetHandoffResolutionExecutionRecord(execution);

    const reservation = await this.reservations.get(attestation.reservationId);
    if (!reservation) throw new MetadataError(`Unknown terminal M42 reservation '${attestation.reservationId}'.`);
    validateRuntimeFleetFairReservationRecord(reservation);

    const admission = await this.admissions.get(attestation.admissionId);
    if (admission) validateRuntimeFleetFairDispatchRecord(admission);

    return { attestation, audit, resolution, execution, reservation, admission };
  }
}

interface EvidenceSnapshot {
  readonly attestation: RuntimeFleetHandoffRecoveryChainAttestationRecord;
  readonly audit: RuntimeFleetHandoffRecoveryAudit;
  readonly resolution: RuntimeFleetHandoffRecoveryResolutionRecord;
  readonly execution: RuntimeFleetHandoffResolutionExecutionRecord;
  readonly reservation: RuntimeFleetFairReservationRecord;
  readonly admission: RuntimeFleetFairDispatchRecord | null;
}

function assertSnapshotMatchesAttestation(snapshot: EvidenceSnapshot): void {
  const { attestation, audit, resolution, execution, reservation, admission } = snapshot;
  if (audit.recoveryId !== attestation.recoveryId || audit.policyId !== attestation.policyId || audit.policyVersion !== attestation.policyVersion) {
    throw new MetadataError(`M44 recovery audit does not match M48 attestation '${attestation.attestationId}'.`);
  }
  if (
    resolution.resolutionId !== attestation.resolutionId
    || resolution.recoveryId !== attestation.recoveryId
    || resolution.reservationId !== attestation.reservationId
    || resolution.admissionId !== attestation.admissionId
    || resolution.action !== attestation.action
    || resolution.actorId !== attestation.actorId
  ) {
    throw new MetadataError(`M45 resolution does not match M48 attestation '${attestation.attestationId}'.`);
  }
  if (
    execution.executionId !== attestation.executionId
    || execution.recoveryId !== attestation.recoveryId
    || execution.resolutionId !== attestation.resolutionId
    || execution.reservationId !== attestation.reservationId
    || execution.admissionId !== attestation.admissionId
    || execution.action !== attestation.action
    || execution.actorId !== attestation.actorId
    || execution.outcome !== attestation.outcome
    || execution.handoffIdentity === undefined
    || canonicalizeJson(execution.handoffIdentity) !== canonicalizeJson(attestation.handoffIdentity)
  ) {
    throw new MetadataError(`M46/M47 execution does not match M48 attestation '${attestation.attestationId}'.`);
  }
  if (
    reservation.reservationId !== attestation.reservationId
    || reservation.admissionId !== attestation.admissionId
    || reservation.status !== attestation.finalReservationStatus
    || reservation.revision !== attestation.finalReservationRevision
  ) {
    throw new MetadataError(`Terminal M42 reservation does not match M48 attestation '${attestation.attestationId}'.`);
  }
  if (attestation.finalAdmissionStatus === undefined) {
    if (admission !== null) throw new MetadataError(`M40 admission appeared after M48 attestation '${attestation.attestationId}'.`);
  } else if (
    admission === null
    || admission.status !== attestation.finalAdmissionStatus
    || admission.revision !== attestation.finalAdmissionRevision
  ) {
    throw new MetadataError(`Terminal M40 admission does not match M48 attestation '${attestation.attestationId}'.`);
  }
}

async function digestSnapshot(snapshot: EvidenceSnapshot): Promise<readonly RuntimeFleetHandoffRecoveryEvidenceComponentDigest[]> {
  const ordered: readonly [RuntimeFleetHandoffRecoveryEvidenceComponent, unknown | null][] = [
    ["audit", snapshot.audit],
    ["resolution", snapshot.resolution],
    ["execution", snapshot.execution],
    ["reservation", snapshot.reservation],
    ["admission", snapshot.admission],
    ["attestation", snapshot.attestation],
  ];
  const result: RuntimeFleetHandoffRecoveryEvidenceComponentDigest[] = [];
  for (const [component, value] of ordered) {
    result.push(value === null
      ? { component, present: false }
      : { component, present: true, digest: await sha256Hex(canonicalizeJson(value)) });
  }
  return result;
}

async function digestRoot(components: readonly RuntimeFleetHandoffRecoveryEvidenceComponentDigest[]): Promise<string> {
  return sha256Hex(canonicalizeJson({
    format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-root",
    formatVersion: 1,
    algorithm: "SHA-256",
    canonicalization: "nublox-json-canonical-v1",
    components,
  }));
}

/** Deterministic JSON canonicalization with lexicographically sorted object keys. */
export function canonicalizeJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new MetadataError("Canonical JSON cannot contain non-finite numbers.");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const child = source[key];
      if (child !== undefined) result[key] = canonicalValue(child);
    }
    return result;
  }
  throw new MetadataError(`Canonical JSON cannot encode value of type '${typeof value}'.`);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const componentOrder: readonly RuntimeFleetHandoffRecoveryEvidenceComponent[] = [
  "audit",
  "resolution",
  "execution",
  "reservation",
  "admission",
  "attestation",
];

export function validateRuntimeFleetHandoffRecoveryEvidenceIntegrityRecord(
  record: RuntimeFleetHandoffRecoveryEvidenceIntegrityRecord,
): void {
  if (
    record.format !== "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-integrity"
    || record.formatVersion !== 1
  ) {
    throw new MetadataError("Unsupported runtime fleet handoff recovery evidence integrity format.");
  }
  for (const [label, value] of Object.entries({
    integrityId: record.integrityId,
    attestationId: record.attestationId,
    recoveryId: record.recoveryId,
    resolutionId: record.resolutionId,
    executionId: record.executionId,
    reservationId: record.reservationId,
    admissionId: record.admissionId,
    rootDigest: record.rootDigest,
    createdAt: record.createdAt,
  })) assertText(value, label);
  if (record.algorithm !== "SHA-256") throw new MetadataError("Unsupported recovery evidence digest algorithm.");
  if (record.canonicalization !== "nublox-json-canonical-v1") {
    throw new MetadataError("Unsupported recovery evidence canonicalization.");
  }
  if (!/^[0-9a-f]{64}$/.test(record.rootDigest)) throw new MetadataError("Recovery evidence rootDigest must be lowercase SHA-256 hex.");
  if (!Number.isFinite(Date.parse(record.createdAt))) throw new MetadataError("Recovery evidence createdAt must be a valid timestamp.");
  if (record.components.length !== componentOrder.length) throw new MetadataError("Recovery evidence requires every ordered component.");
  record.components.forEach((component, index) => {
    if (component.component !== componentOrder[index]) throw new MetadataError("Recovery evidence components are not in canonical order.");
    if (component.present) {
      if (component.digest === undefined || !/^[0-9a-f]{64}$/.test(component.digest)) {
        throw new MetadataError(`Recovery evidence component '${component.component}' requires a lowercase SHA-256 digest.`);
      }
    } else if (component.digest !== undefined) {
      throw new MetadataError(`Absent recovery evidence component '${component.component}' cannot contain a digest.`);
    }
    if (component.component !== "admission" && !component.present) {
      throw new MetadataError(`Recovery evidence component '${component.component}' must be present.`);
    }
  });
}

function assertText(value: string, label: string): void {
  if (!value.trim()) throw new MetadataError(`Runtime fleet handoff recovery evidence integrity ${label} is required.`);
}
