import { ConcurrencyError, MetadataError } from "../errors/errors.js";
import type { RuntimeFleetFairDispatchRecord } from "./runtime-fleet-convergence-fair-dispatch.js";
import { validateRuntimeFleetFairDispatchRecord } from "./runtime-fleet-convergence-fair-dispatch.js";
import type { RuntimeFleetFairReservationRecord } from "./runtime-fleet-convergence-fair-reservation.js";
import { validateRuntimeFleetFairReservationRecord } from "./runtime-fleet-convergence-fair-reservation.js";
import type {
  RuntimeFleetHandoffRecoveryAudit,
  RuntimeFleetHandoffRecoveryDecision,
} from "./runtime-fleet-convergence-handoff-recovery.js";
import { validateRuntimeFleetHandoffRecoveryAudit } from "./runtime-fleet-convergence-handoff-recovery.js";
import type { RuntimeFleetHandoffRecoveryResolutionRecord } from "./runtime-fleet-convergence-handoff-resolution.js";
import { validateRuntimeFleetHandoffRecoveryResolutionRecord } from "./runtime-fleet-convergence-handoff-resolution.js";
import type {
  RuntimeFleetHandoffResolutionExecutionIdentity,
  RuntimeFleetHandoffResolutionExecutionRecord,
} from "./runtime-fleet-convergence-handoff-resolution-execution.js";
import { validateRuntimeFleetHandoffResolutionExecutionRecord } from "./runtime-fleet-convergence-handoff-resolution-execution.js";

export interface RuntimeFleetHandoffRecoveryChainAttestationRecord {
  readonly format: "nublox-metaobject-runtime-fleet-handoff-recovery-chain-attestation";
  readonly formatVersion: 1;
  readonly attestationId: string;
  readonly recoveryId: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly resolutionId: string;
  readonly executionId: string;
  readonly reservationId: string;
  readonly admissionId: string;
  readonly action: RuntimeFleetHandoffRecoveryResolutionRecord["action"];
  readonly actorId: string;
  readonly outcome: NonNullable<RuntimeFleetHandoffResolutionExecutionRecord["outcome"]>;
  readonly handoffIdentity: RuntimeFleetHandoffResolutionExecutionIdentity;
  readonly finalReservationStatus: NonNullable<RuntimeFleetHandoffResolutionExecutionRecord["finalReservationStatus"]>;
  readonly finalReservationRevision: number;
  readonly finalAdmissionStatus?: RuntimeFleetFairDispatchRecord["status"];
  readonly finalAdmissionRevision?: number;
  readonly verifiedAt: string;
}

export interface RuntimeFleetHandoffRecoveryChainAttestationFilter {
  readonly recoveryId?: string;
  readonly actorId?: string;
  readonly action?: RuntimeFleetHandoffRecoveryResolutionRecord["action"];
}

export interface RuntimeFleetHandoffRecoveryChainAttestationStore {
  get(attestationId: string): Promise<RuntimeFleetHandoffRecoveryChainAttestationRecord | null>;
  list(
    filter?: RuntimeFleetHandoffRecoveryChainAttestationFilter,
  ): Promise<readonly RuntimeFleetHandoffRecoveryChainAttestationRecord[]>;
  create(record: RuntimeFleetHandoffRecoveryChainAttestationRecord): Promise<RuntimeFleetHandoffRecoveryChainAttestationRecord>;
}

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryRuntimeFleetHandoffRecoveryChainAttestationStore
implements RuntimeFleetHandoffRecoveryChainAttestationStore {
  readonly #records = new Map<string, RuntimeFleetHandoffRecoveryChainAttestationRecord>();

  async get(attestationId: string): Promise<RuntimeFleetHandoffRecoveryChainAttestationRecord | null> {
    const record = this.#records.get(attestationId);
    return record ? clone(record) : null;
  }

  async list(
    filter: RuntimeFleetHandoffRecoveryChainAttestationFilter = {},
  ): Promise<readonly RuntimeFleetHandoffRecoveryChainAttestationRecord[]> {
    return [...this.#records.values()]
      .filter((record) => filter.recoveryId === undefined || record.recoveryId === filter.recoveryId)
      .filter((record) => filter.actorId === undefined || record.actorId === filter.actorId)
      .filter((record) => filter.action === undefined || record.action === filter.action)
      .sort((left, right) => left.verifiedAt.localeCompare(right.verifiedAt) || left.attestationId.localeCompare(right.attestationId))
      .map(clone);
  }

  async create(
    record: RuntimeFleetHandoffRecoveryChainAttestationRecord,
  ): Promise<RuntimeFleetHandoffRecoveryChainAttestationRecord> {
    validateRuntimeFleetHandoffRecoveryChainAttestationRecord(record);
    if (this.#records.has(record.attestationId)) {
      throw new ConcurrencyError(`Runtime fleet handoff recovery chain attestation '${record.attestationId}' already exists.`);
    }
    const stored = clone(record);
    this.#records.set(stored.attestationId, stored);
    return clone(stored);
  }
}

export interface RuntimeFleetHandoffRecoveryChainAuditSource {
  get(recoveryId: string): Promise<RuntimeFleetHandoffRecoveryAudit | null>;
}

export interface RuntimeFleetHandoffRecoveryChainResolutionSource {
  get(resolutionId: string): Promise<RuntimeFleetHandoffRecoveryResolutionRecord | null>;
}

export interface RuntimeFleetHandoffRecoveryChainExecutionSource {
  get(executionId: string): Promise<RuntimeFleetHandoffResolutionExecutionRecord | null>;
}

export interface RuntimeFleetHandoffRecoveryChainReservationSource {
  get(reservationId: string): Promise<RuntimeFleetFairReservationRecord | null>;
}

export interface RuntimeFleetHandoffRecoveryChainAdmissionSource {
  get(admissionId: string): Promise<RuntimeFleetFairDispatchRecord | null>;
}

export interface RuntimeFleetHandoffRecoveryChainAttestationRequest {
  readonly attestationId: string;
  readonly executionId: string;
}

export type RuntimeFleetHandoffRecoveryChainAttestationClock = () => Date;

/**
 * Verify one completed M44 -> M45 -> M46/M47 -> M42/M40 recovery chain and
 * persist a create-only attestation. No mutation is performed on the governed
 * recovery records themselves.
 */
export class RuntimeFleetHandoffRecoveryChainAttestationCatalog {
  constructor(
    private readonly audits: RuntimeFleetHandoffRecoveryChainAuditSource,
    private readonly resolutions: RuntimeFleetHandoffRecoveryChainResolutionSource,
    private readonly executions: RuntimeFleetHandoffRecoveryChainExecutionSource,
    private readonly reservations: RuntimeFleetHandoffRecoveryChainReservationSource,
    private readonly admissions: RuntimeFleetHandoffRecoveryChainAdmissionSource,
    private readonly attestations: RuntimeFleetHandoffRecoveryChainAttestationStore,
    private readonly clock: RuntimeFleetHandoffRecoveryChainAttestationClock = () => new Date(),
  ) {}

  async attest(
    request: RuntimeFleetHandoffRecoveryChainAttestationRequest,
  ): Promise<RuntimeFleetHandoffRecoveryChainAttestationRecord> {
    assertText(request.attestationId, "attestationId");
    assertText(request.executionId, "executionId");
    if (await this.attestations.get(request.attestationId)) {
      throw new ConcurrencyError(`Runtime fleet handoff recovery chain attestation '${request.attestationId}' already exists.`);
    }

    const execution = await this.executions.get(request.executionId);
    if (!execution) throw new MetadataError(`Unknown M46 execution '${request.executionId}'.`);
    validateRuntimeFleetHandoffResolutionExecutionRecord(execution);
    if (execution.status !== "completed" || execution.outcome === undefined) {
      throw new MetadataError(`M46 execution '${execution.executionId}' is '${execution.status}' and cannot be attested.`);
    }
    if (execution.handoffIdentity === undefined) {
      throw new MetadataError(
        `M46 execution '${execution.executionId}' is a legacy receipt without M47 full handoff identity and cannot receive full-chain attestation.`,
      );
    }

    const resolution = await this.resolutions.get(execution.resolutionId);
    if (!resolution) throw new MetadataError(`Unknown M45 resolution '${execution.resolutionId}'.`);
    validateRuntimeFleetHandoffRecoveryResolutionRecord(resolution);
    assertExecutionResolutionChain(execution, resolution);

    const audit = await this.audits.get(execution.recoveryId);
    if (!audit) throw new MetadataError(`Unknown M44 recovery audit '${execution.recoveryId}'.`);
    validateRuntimeFleetHandoffRecoveryAudit(audit);
    const decision = requireReviewDecision(audit, resolution.reservationId);
    assertResolutionAuditChain(resolution, decision);

    const reservation = await this.reservations.get(execution.reservationId);
    if (!reservation) throw new MetadataError(`Unknown terminal M42 reservation '${execution.reservationId}'.`);
    validateRuntimeFleetFairReservationRecord(reservation);
    assertTerminalReservationChain(execution, reservation);

    const admission = await this.admissions.get(execution.admissionId);
    if (admission) validateRuntimeFleetFairDispatchRecord(admission);
    assertTerminalAdmissionChain(execution, admission);

    const record: RuntimeFleetHandoffRecoveryChainAttestationRecord = {
      format: "nublox-metaobject-runtime-fleet-handoff-recovery-chain-attestation",
      formatVersion: 1,
      attestationId: request.attestationId,
      recoveryId: audit.recoveryId,
      policyId: audit.policyId,
      policyVersion: audit.policyVersion,
      resolutionId: resolution.resolutionId,
      executionId: execution.executionId,
      reservationId: reservation.reservationId,
      admissionId: execution.admissionId,
      action: resolution.action,
      actorId: resolution.actorId,
      outcome: execution.outcome,
      handoffIdentity: clone(execution.handoffIdentity),
      finalReservationStatus: reservation.status,
      finalReservationRevision: reservation.revision,
      ...(admission === null ? {} : {
        finalAdmissionStatus: admission.status,
        finalAdmissionRevision: admission.revision,
      }),
      verifiedAt: this.clock().toISOString(),
    };
    return this.attestations.create(record);
  }

  async get(attestationId: string): Promise<RuntimeFleetHandoffRecoveryChainAttestationRecord | null> {
    assertText(attestationId, "attestationId");
    return this.attestations.get(attestationId);
  }

  async history(
    filter: RuntimeFleetHandoffRecoveryChainAttestationFilter = {},
  ): Promise<readonly RuntimeFleetHandoffRecoveryChainAttestationRecord[]> {
    return this.attestations.list(filter);
  }
}

function assertExecutionResolutionChain(
  execution: RuntimeFleetHandoffResolutionExecutionRecord,
  resolution: RuntimeFleetHandoffRecoveryResolutionRecord,
): void {
  if (
    execution.resolutionId !== resolution.resolutionId
    || execution.recoveryId !== resolution.recoveryId
    || execution.reservationId !== resolution.reservationId
    || execution.admissionId !== resolution.admissionId
    || execution.action !== resolution.action
    || execution.actorId !== resolution.actorId
  ) {
    throw new MetadataError(`M46 execution '${execution.executionId}' does not match M45 resolution '${resolution.resolutionId}'.`);
  }
  const identity = execution.handoffIdentity;
  if (
    identity === undefined
    || identity.dispatchId !== resolution.dispatchId
    || identity.workerId !== resolution.workerId
    || identity.handoffAt !== resolution.handoffAt
  ) {
    throw new MetadataError(`M47 handoff identity does not match M45 resolution '${resolution.resolutionId}'.`);
  }
}

function requireReviewDecision(
  audit: RuntimeFleetHandoffRecoveryAudit,
  reservationId: string,
): RuntimeFleetHandoffRecoveryDecision {
  const decision = audit.decisions.find((candidate) => candidate.reservationId === reservationId);
  if (!decision) {
    throw new MetadataError(`M44 recovery audit '${audit.recoveryId}' has no decision for reservation '${reservationId}'.`);
  }
  if (decision.action !== "review") {
    throw new MetadataError(
      `M45 resolution '${reservationId}' must originate from an M44 review decision, found '${decision.action}'.`,
    );
  }
  return decision;
}

function assertResolutionAuditChain(
  resolution: RuntimeFleetHandoffRecoveryResolutionRecord,
  decision: RuntimeFleetHandoffRecoveryDecision,
): void {
  if (
    resolution.recoveryId === ""
    || resolution.reservationId !== decision.reservationId
    || resolution.reservationRevision !== decision.reservationRevision
    || resolution.admissionId !== decision.admissionId
    || resolution.dispatchId !== decision.dispatchId
    || resolution.workerId !== decision.workerId
    || resolution.handoffAt !== decision.handoffAt
    || resolution.admissionStatus !== decision.admissionStatus
    || resolution.admissionRevision !== decision.admissionRevision
  ) {
    throw new MetadataError(`M45 resolution '${resolution.resolutionId}' does not match its M44 review evidence.`);
  }
}

function assertTerminalReservationChain(
  execution: RuntimeFleetHandoffResolutionExecutionRecord,
  reservation: RuntimeFleetFairReservationRecord,
): void {
  const expectedStatus = execution.action === "resume" ? "consumed" : "released";
  if (reservation.status !== expectedStatus) {
    throw new MetadataError(
      `Terminal M42 reservation '${reservation.reservationId}' is '${reservation.status}', expected '${expectedStatus}'.`,
    );
  }
  if (
    reservation.reservationId !== execution.reservationId
    || reservation.admissionId !== execution.admissionId
    || reservation.revision !== execution.finalReservationRevision
  ) {
    throw new MetadataError(`Terminal M42 reservation does not match M46 execution '${execution.executionId}'.`);
  }
  const identity = execution.handoffIdentity;
  if (identity === undefined) throw new MetadataError("M47 handoff identity is required for attestation.");
  const currentIdentity: RuntimeFleetHandoffResolutionExecutionIdentity = {
    dispatchId: reservation.dispatchId,
    workerId: reservation.workerId,
    handoffAt: reservation.handoffAt ?? "",
    work: reservation.work.map((item) => ({
      workId: item.workId,
      runtimeId: item.runtimeId,
      action: item.action,
      workRevision: item.workRevision,
      fairnessRank: item.fairnessRank,
    })),
  };
  if (JSON.stringify(identity) !== JSON.stringify(currentIdentity)) {
    throw new MetadataError(`Terminal M42 reservation identity does not match M47 execution '${execution.executionId}'.`);
  }
}

function assertTerminalAdmissionChain(
  execution: RuntimeFleetHandoffResolutionExecutionRecord,
  admission: RuntimeFleetFairDispatchRecord | null,
): void {
  if (execution.finalAdmissionStatus === undefined) {
    if (admission !== null) {
      throw new MetadataError(`M40 admission '${execution.admissionId}' appeared after M46 final evidence.`);
    }
    return;
  }
  if (
    admission === null
    || admission.admissionId !== execution.admissionId
    || admission.status !== execution.finalAdmissionStatus
    || admission.revision !== execution.finalAdmissionRevision
  ) {
    throw new MetadataError(`Terminal M40 admission does not match M46 execution '${execution.executionId}'.`);
  }
}

export function validateRuntimeFleetHandoffRecoveryChainAttestationRecord(
  record: RuntimeFleetHandoffRecoveryChainAttestationRecord,
): void {
  if (
    record.format !== "nublox-metaobject-runtime-fleet-handoff-recovery-chain-attestation"
    || record.formatVersion !== 1
  ) {
    throw new MetadataError("Unsupported runtime fleet handoff recovery chain attestation format.");
  }
  for (const [label, value] of Object.entries({
    attestationId: record.attestationId,
    recoveryId: record.recoveryId,
    policyId: record.policyId,
    resolutionId: record.resolutionId,
    executionId: record.executionId,
    reservationId: record.reservationId,
    admissionId: record.admissionId,
    actorId: record.actorId,
    verifiedAt: record.verifiedAt,
  })) assertText(value, label);
  assertPositiveInteger(record.policyVersion, "policyVersion");
  assertPositiveInteger(record.finalReservationRevision, "finalReservationRevision");
  if (!Number.isFinite(Date.parse(record.verifiedAt))) {
    throw new MetadataError("Runtime fleet handoff recovery chain attestation verifiedAt must be a valid timestamp.");
  }
  if ((record.finalAdmissionStatus === undefined) !== (record.finalAdmissionRevision === undefined)) {
    throw new MetadataError("Attestation finalAdmissionStatus and finalAdmissionRevision must be supplied together.");
  }
  if (record.finalAdmissionRevision !== undefined) assertPositiveInteger(record.finalAdmissionRevision, "finalAdmissionRevision");
  if (record.action === "resume") {
    if (record.outcome !== "resumed" || record.finalReservationStatus !== "consumed") {
      throw new MetadataError("Resume chain attestation requires resumed outcome and consumed reservation.");
    }
  } else if (record.action === "cancel") {
    if (record.outcome !== "cancelled" || record.finalReservationStatus !== "released") {
      throw new MetadataError("Cancel chain attestation requires cancelled outcome and released reservation.");
    }
  } else {
    throw new MetadataError(`Invalid recovery chain attestation action '${String(record.action)}'.`);
  }
  validateAttestedIdentity(record.handoffIdentity);
}

function validateAttestedIdentity(identity: RuntimeFleetHandoffResolutionExecutionIdentity): void {
  assertText(identity.dispatchId, "handoffIdentity.dispatchId");
  assertText(identity.workerId, "handoffIdentity.workerId");
  if (!Number.isFinite(Date.parse(identity.handoffAt))) {
    throw new MetadataError("Attestation handoffIdentity.handoffAt must be a valid timestamp.");
  }
  if (identity.work.length === 0) throw new MetadataError("Attestation handoffIdentity requires work.");
  const ids = new Set<string>();
  let rank = 0;
  for (const item of identity.work) {
    assertText(item.workId, "handoffIdentity.workId");
    assertText(item.runtimeId, "handoffIdentity.runtimeId");
    assertPositiveInteger(item.workRevision, "handoffIdentity.workRevision");
    assertPositiveInteger(item.fairnessRank, "handoffIdentity.fairnessRank");
    if (item.fairnessRank <= rank) throw new MetadataError("Attestation handoffIdentity fairness ranks must ascend.");
    if (ids.has(item.workId)) throw new MetadataError(`Attestation handoffIdentity contains duplicate work '${item.workId}'.`);
    rank = item.fairnessRank;
    ids.add(item.workId);
  }
}

function assertText(value: string, label: string): void {
  if (!value.trim()) throw new MetadataError(`Runtime fleet handoff recovery chain attestation ${label} is required.`);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new MetadataError(`Runtime fleet handoff recovery chain attestation ${label} must be a positive integer.`);
  }
}
