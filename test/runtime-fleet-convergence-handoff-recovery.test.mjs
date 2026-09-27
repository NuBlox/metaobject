import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryRuntimeFleetHandoffRecoveryStore,
  RuntimeFleetHandoffRecoveryCatalog,
} from "../dist/index.js";

function handoff(id, handoffAt, revision = 2) {
  return {
    format: "nublox-metaobject-runtime-fleet-fair-reservation",
    formatVersion: 1,
    reservationId: `reservation-${id}`,
    revision,
    status: "handoff",
    fairnessId: `fair-${id}`,
    fairnessPolicyId: "fairness",
    fairnessPolicyVersion: 1,
    sourceEvaluationId: `queue-${id}`,
    admissionId: `admission-${id}`,
    dispatchId: `dispatch-${id}`,
    workerId: "worker-a",
    work: [{
      workId: `work-${id}`,
      runtimeId: `runtime-${id}`,
      action: "review",
      workRevision: 1,
      fairnessRank: 1,
    }],
    acquiredAt: "2026-09-27T10:00:00.000Z",
    expiresAt: "2026-09-27T10:01:00.000Z",
    handoffAt,
  };
}

function admission(reservation, status, revision = 1) {
  return {
    format: "nublox-metaobject-runtime-fleet-fair-dispatch",
    formatVersion: 1,
    admissionId: reservation.admissionId,
    revision,
    status,
    fairnessId: reservation.fairnessId,
    fairnessPolicyId: reservation.fairnessPolicyId,
    fairnessPolicyVersion: reservation.fairnessPolicyVersion,
    sourceEvaluationId: reservation.sourceEvaluationId,
    sourcePolicyId: "safety",
    sourcePolicyVersion: 1,
    dispatchId: reservation.dispatchId,
    workerId: reservation.workerId,
    work: reservation.work.map((item) => ({
      workId: item.workId,
      runtimeId: item.runtimeId,
      action: item.action,
      evaluatedRevision: item.workRevision,
      fairnessRank: item.fairnessRank,
      effectivePriority: 10,
      starved: false,
    })),
    admittedAt: "2026-09-27T10:00:05.000Z",
    ...(status === "completed" ? {
      dispatchOutcome: "completed",
      finishedAt: "2026-09-27T10:00:10.000Z",
    } : {}),
    ...(status === "failed" ? {
      error: "executor failed",
      finishedAt: "2026-09-27T10:00:10.000Z",
    } : {}),
    ...(status === "cancelled" ? {
      reason: "operator cancelled",
      finishedAt: "2026-09-27T10:00:10.000Z",
    } : {}),
  };
}

const policy = {
  format: "nublox-metaobject-runtime-fleet-handoff-recovery-policy",
  formatVersion: 1,
  policyId: "default-recovery",
  version: 1,
  reviewAfterMs: 60_000,
  cancelAfterMs: 300_000,
};

function fixture(records, admissionRecords = []) {
  const byReservation = new Map(records.map((record) => [record.reservationId, structuredClone(record)]));
  const byAdmission = new Map(admissionRecords.map((record) => [record.admissionId, structuredClone(record)]));
  const calls = [];
  const reservations = {
    async get(id) {
      return byReservation.has(id) ? structuredClone(byReservation.get(id)) : null;
    },
    async history(filter = {}) {
      return [...byReservation.values()]
        .filter((record) => filter.status === undefined || record.status === filter.status)
        .map(structuredClone);
    },
    async resume(id) {
      calls.push(["resume", id]);
      const current = byReservation.get(id);
      const updated = {
        ...current,
        revision: current.revision + 1,
        status: "consumed",
        fairAdmissionStatus: "completed",
        dispatchOutcome: "completed",
        finishedAt: "2026-09-27T12:00:01.000Z",
      };
      byReservation.set(id, updated);
      return { reservation: structuredClone(updated) };
    },
    async release(id, reason, expectedRevision) {
      calls.push(["release", id, reason, expectedRevision]);
      const current = byReservation.get(id);
      if (current.revision !== expectedRevision) throw new Error("revision conflict");
      const updated = {
        ...current,
        revision: current.revision + 1,
        status: "released",
        reason,
        finishedAt: "2026-09-27T12:00:01.000Z",
      };
      byReservation.set(id, updated);
      return structuredClone(updated);
    },
  };
  const admissions = {
    async get(id) {
      return byAdmission.has(id) ? structuredClone(byAdmission.get(id)) : null;
    },
  };
  const store = new MemoryRuntimeFleetHandoffRecoveryStore();
  const catalog = new RuntimeFleetHandoffRecoveryCatalog(
    reservations,
    admissions,
    store,
    () => new Date("2026-09-27T12:00:00.000Z"),
  );
  return { catalog, store, byReservation, byAdmission, calls };
}

test("classifies fresh, aging and abandoned handoffs deterministically", async () => {
  const fresh = handoff("fresh", "2026-09-27T11:59:30.000Z");
  const aging = handoff("aging", "2026-09-27T11:58:00.000Z");
  const abandoned = handoff("abandoned", "2026-09-27T11:50:00.000Z");
  const { catalog } = fixture([fresh, aging, abandoned]);

  const audit = await catalog.audit({ recoveryId: "recovery-1", policy });

  assert.equal(audit.total, 3);
  assert.equal(audit.resume, 1);
  assert.equal(audit.review, 1);
  assert.equal(audit.cancel, 1);
  assert.deepEqual(
    Object.fromEntries(audit.decisions.map((decision) => [decision.reservationId, decision.action])),
    {
      "reservation-abandoned": "cancel",
      "reservation-aging": "review",
      "reservation-fresh": "resume",
    },
  );
});

test("existing M40 evidence overrides age-only policy", async () => {
  const admittedReservation = handoff("admitted", "2026-09-27T11:00:00.000Z");
  const cancelledReservation = handoff("cancelled", "2026-09-27T11:59:50.000Z");
  const { catalog } = fixture(
    [admittedReservation, cancelledReservation],
    [
      admission(admittedReservation, "admitted", 3),
      admission(cancelledReservation, "cancelled", 2),
    ],
  );

  const audit = await catalog.audit({ recoveryId: "recovery-evidence", policy });
  const admittedDecision = audit.decisions.find((decision) => decision.reservationId === admittedReservation.reservationId);
  const cancelledDecision = audit.decisions.find((decision) => decision.reservationId === cancelledReservation.reservationId);

  assert.equal(admittedDecision.action, "resume");
  assert.equal(admittedDecision.admissionStatus, "admitted");
  assert.equal(admittedDecision.admissionRevision, 3);
  assert.equal(cancelledDecision.action, "cancel");
  assert.equal(cancelledDecision.admissionStatus, "cancelled");
});

test("executes explicit resume/cancel decisions while review remains non-mutating", async () => {
  const fresh = handoff("fresh", "2026-09-27T11:59:30.000Z");
  const review = handoff("review", "2026-09-27T11:58:00.000Z");
  const cancel = handoff("cancel", "2026-09-27T11:50:00.000Z");
  const { catalog, calls } = fixture([fresh, review, cancel]);
  await catalog.audit({ recoveryId: "recovery-execute", policy });

  const resumed = await catalog.execute("recovery-execute", fresh.reservationId);
  const reviewed = await catalog.execute("recovery-execute", review.reservationId);
  const cancelled = await catalog.execute("recovery-execute", cancel.reservationId);

  assert.equal(resumed.outcome, "resumed");
  assert.equal(resumed.reservation.status, "consumed");
  assert.equal(reviewed.outcome, "review-required");
  assert.equal(reviewed.reservation.status, "handoff");
  assert.equal(cancelled.outcome, "cancelled");
  assert.equal(cancelled.reservation.status, "released");
  assert.deepEqual(calls.map((call) => call[0]), ["resume", "release"]);
});

test("execution fails closed when reservation or M40 evidence changes after audit", async () => {
  const reservation = handoff("stale", "2026-09-27T11:59:30.000Z");
  const { catalog, byReservation, byAdmission } = fixture([reservation]);
  await catalog.audit({ recoveryId: "recovery-stale", policy });

  byReservation.set(reservation.reservationId, { ...reservation, revision: reservation.revision + 1 });
  await assert.rejects(
    () => catalog.execute("recovery-stale", reservation.reservationId),
    /changed after M44 recovery audit/i,
  );

  byReservation.set(reservation.reservationId, structuredClone(reservation));
  byAdmission.set(reservation.admissionId, admission(reservation, "admitted", 1));
  await assert.rejects(
    () => catalog.execute("recovery-stale", reservation.reservationId),
    /appeared after M44 recovery audit/i,
  );
});

test("audit history is immutable, detached and duplicate recovery IDs are rejected", async () => {
  const reservation = handoff("history", "2026-09-27T11:59:30.000Z");
  const { catalog } = fixture([reservation]);
  const audit = await catalog.audit({ recoveryId: "recovery-history", policy });

  audit.decisions[0].reason = "mutated";
  const persisted = await catalog.get("recovery-history");
  assert.notEqual(persisted.decisions[0].reason, "mutated");
  await assert.rejects(
    () => catalog.audit({ recoveryId: "recovery-history", policy }),
    /already exists/i,
  );
});

test("invalid policy thresholds fail before audit evidence is persisted", async () => {
  const reservation = handoff("policy", "2026-09-27T11:59:30.000Z");
  const { catalog } = fixture([reservation]);

  await assert.rejects(
    () => catalog.audit({
      recoveryId: "recovery-invalid",
      policy: { ...policy, cancelAfterMs: policy.reviewAfterMs },
    }),
    /cancelAfterMs must be greater/i,
  );
  assert.equal(await catalog.get("recovery-invalid"), null);
});
