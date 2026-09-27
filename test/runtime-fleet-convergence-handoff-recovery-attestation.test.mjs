import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryRuntimeFleetHandoffRecoveryChainAttestationStore,
  RuntimeFleetHandoffRecoveryChainAttestationCatalog,
} from "../dist/index.js";

function identity() {
  return {
    dispatchId: "dispatch-1",
    workerId: "worker-a",
    handoffAt: "2026-09-27T11:58:00.000Z",
    work: [{
      workId: "work-1",
      runtimeId: "runtime-1",
      action: "review",
      workRevision: 1,
      fairnessRank: 1,
    }],
  };
}

function audit() {
  return {
    format: "nublox-metaobject-runtime-fleet-handoff-recovery-audit",
    formatVersion: 1,
    recoveryId: "recovery-1",
    policyId: "default-recovery",
    policyVersion: 1,
    decisions: [{
      reservationId: "reservation-1",
      reservationRevision: 2,
      admissionId: "admission-1",
      dispatchId: "dispatch-1",
      workerId: "worker-a",
      handoffAt: "2026-09-27T11:58:00.000Z",
      ageMs: 120_000,
      action: "review",
      reason: "manual review required",
    }],
    total: 1,
    resume: 0,
    cancel: 0,
    review: 1,
    evaluatedAt: "2026-09-27T12:00:00.000Z",
  };
}

function resolution(action = "resume") {
  return {
    format: "nublox-metaobject-runtime-fleet-handoff-recovery-resolution",
    formatVersion: 1,
    resolutionId: `resolution-${action}`,
    recoveryId: "recovery-1",
    reservationId: "reservation-1",
    reservationRevision: 2,
    admissionId: "admission-1",
    dispatchId: "dispatch-1",
    workerId: "worker-a",
    handoffAt: "2026-09-27T11:58:00.000Z",
    action,
    actorId: "operator-1",
    reason: `${action} approved`,
    resolvedAt: "2026-09-27T12:01:00.000Z",
  };
}

function execution(action = "resume", overrides = {}) {
  const terminal = action === "resume"
    ? { outcome: "resumed", finalReservationStatus: "consumed", finalAdmissionStatus: "completed" }
    : { outcome: "cancelled", finalReservationStatus: "released", finalAdmissionStatus: "cancelled" };
  return {
    format: "nublox-metaobject-runtime-fleet-handoff-resolution-execution",
    formatVersion: 1,
    executionId: `execution-${action}`,
    revision: 2,
    status: "completed",
    resolutionId: `resolution-${action}`,
    recoveryId: "recovery-1",
    reservationId: "reservation-1",
    action,
    actorId: "operator-1",
    startReservationRevision: 2,
    admissionId: "admission-1",
    handoffIdentity: identity(),
    startedAt: "2026-09-27T12:02:00.000Z",
    outcome: terminal.outcome,
    finalReservationStatus: terminal.finalReservationStatus,
    finalReservationRevision: 3,
    finalAdmissionStatus: terminal.finalAdmissionStatus,
    finalAdmissionRevision: 2,
    finishedAt: "2026-09-27T12:03:00.000Z",
    ...overrides,
  };
}

function reservation(action = "resume", overrides = {}) {
  const status = action === "resume" ? "consumed" : "released";
  return {
    format: "nublox-metaobject-runtime-fleet-fair-reservation",
    formatVersion: 1,
    reservationId: "reservation-1",
    revision: 3,
    status,
    fairnessId: "fair-1",
    fairnessPolicyId: "fairness",
    fairnessPolicyVersion: 1,
    sourceEvaluationId: "queue-1",
    admissionId: "admission-1",
    dispatchId: "dispatch-1",
    workerId: "worker-a",
    work: identity().work,
    acquiredAt: "2026-09-27T10:00:00.000Z",
    expiresAt: "2026-09-27T10:01:00.000Z",
    handoffAt: "2026-09-27T11:58:00.000Z",
    ...(action === "resume" ? {
      fairAdmissionStatus: "completed",
      dispatchOutcome: "completed",
    } : {
      reason: "M43 cancellation fence",
    }),
    finishedAt: "2026-09-27T12:03:00.000Z",
    ...overrides,
  };
}

function admission(action = "resume") {
  const status = action === "resume" ? "completed" : "cancelled";
  return {
    format: "nublox-metaobject-runtime-fleet-fair-dispatch",
    formatVersion: 1,
    admissionId: "admission-1",
    revision: 2,
    status,
    fairnessId: "fair-1",
    fairnessPolicyId: "fairness",
    fairnessPolicyVersion: 1,
    sourceEvaluationId: "queue-1",
    sourcePolicyId: "safety",
    sourcePolicyVersion: 1,
    dispatchId: "dispatch-1",
    workerId: "worker-a",
    work: identity().work.map((item) => ({
      workId: item.workId,
      runtimeId: item.runtimeId,
      action: item.action,
      evaluatedRevision: item.workRevision,
      fairnessRank: item.fairnessRank,
      effectivePriority: 10,
      starved: false,
    })),
    admittedAt: "2026-09-27T12:02:10.000Z",
    ...(status === "completed" ? { dispatchOutcome: "completed" } : { reason: "cancelled" }),
    finishedAt: "2026-09-27T12:02:30.000Z",
  };
}

function fixture(action = "resume", overrides = {}) {
  const values = {
    audit: audit(),
    resolution: resolution(action),
    execution: execution(action),
    reservation: reservation(action),
    admission: admission(action),
    ...overrides,
  };
  const audits = { async get(id) { return id === values.audit.recoveryId ? structuredClone(values.audit) : null; } };
  const resolutions = { async get(id) { return id === values.resolution.resolutionId ? structuredClone(values.resolution) : null; } };
  const executions = { async get(id) { return id === values.execution.executionId ? structuredClone(values.execution) : null; } };
  const reservations = { async get(id) { return id === values.reservation.reservationId ? structuredClone(values.reservation) : null; } };
  const admissions = { async get(id) { return id === values.admission.admissionId ? structuredClone(values.admission) : null; } };
  const store = new MemoryRuntimeFleetHandoffRecoveryChainAttestationStore();
  const catalog = new RuntimeFleetHandoffRecoveryChainAttestationCatalog(
    audits,
    resolutions,
    executions,
    reservations,
    admissions,
    store,
    () => new Date("2026-09-27T12:04:00.000Z"),
  );
  return { catalog, store, values };
}

test("attests a complete resume recovery chain", async () => {
  const { catalog } = fixture("resume");
  const result = await catalog.attest({ attestationId: "attestation-resume", executionId: "execution-resume" });

  assert.equal(result.action, "resume");
  assert.equal(result.outcome, "resumed");
  assert.equal(result.finalReservationStatus, "consumed");
  assert.equal(result.finalAdmissionStatus, "completed");
  assert.equal(result.actorId, "operator-1");
  assert.deepEqual(result.handoffIdentity, identity());
});

test("attests a complete M43-cancelled recovery chain", async () => {
  const { catalog } = fixture("cancel");
  const result = await catalog.attest({ attestationId: "attestation-cancel", executionId: "execution-cancel" });

  assert.equal(result.action, "cancel");
  assert.equal(result.outcome, "cancelled");
  assert.equal(result.finalReservationStatus, "released");
  assert.equal(result.finalAdmissionStatus, "cancelled");
});

test("rejects legacy M46 receipts without M47 full identity", async () => {
  const legacy = execution("resume");
  delete legacy.handoffIdentity;
  const { catalog } = fixture("resume", { execution: legacy });

  await assert.rejects(
    () => catalog.attest({ attestationId: "attestation-legacy", executionId: legacy.executionId }),
    /legacy receipt without M47 full handoff identity/i,
  );
});

test("rejects a terminal reservation whose immutable M47 identity differs", async () => {
  const forged = reservation("resume", { workerId: "worker-forged" });
  const { catalog } = fixture("resume", { reservation: forged });

  await assert.rejects(
    () => catalog.attest({ attestationId: "attestation-forged", executionId: "execution-resume" }),
    /identity does not match M47/i,
  );
});

test("rejects an M45 resolution that no longer matches its M44 review evidence", async () => {
  const mismatched = resolution("resume");
  mismatched.reservationRevision = 99;
  const { catalog } = fixture("resume", { resolution: mismatched });

  await assert.rejects(
    () => catalog.attest({ attestationId: "attestation-mismatch", executionId: "execution-resume" }),
    /does not match its M44 review evidence/i,
  );
});

test("attestation history is create-only, detached and filterable", async () => {
  const { catalog } = fixture("resume");
  const result = await catalog.attest({ attestationId: "attestation-history", executionId: "execution-resume" });
  result.actorId = "mutated";

  const persisted = await catalog.get("attestation-history");
  assert.equal(persisted.actorId, "operator-1");
  assert.equal((await catalog.history({ actorId: "operator-1" })).length, 1);
  assert.equal((await catalog.history({ action: "cancel" })).length, 0);
  await assert.rejects(
    () => catalog.attest({ attestationId: "attestation-history", executionId: "execution-resume" }),
    /already exists/i,
  );
});
