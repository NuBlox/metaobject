import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryRuntimeFleetHandoffRecoveryResolutionStore,
  RuntimeFleetHandoffRecoveryResolutionCatalog,
} from "../dist/index.js";

function reservation(id = "one", revision = 2) {
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
    handoffAt: "2026-09-27T11:58:00.000Z",
  };
}

function auditFor(record, action = "review") {
  return {
    format: "nublox-metaobject-runtime-fleet-handoff-recovery-audit",
    formatVersion: 1,
    recoveryId: `recovery-${record.reservationId}`,
    policyId: "default-recovery",
    policyVersion: 1,
    decisions: [{
      reservationId: record.reservationId,
      reservationRevision: record.revision,
      admissionId: record.admissionId,
      dispatchId: record.dispatchId,
      workerId: record.workerId,
      handoffAt: record.handoffAt,
      ageMs: 120_000,
      action,
      reason: action === "review" ? "manual decision required" : `${action} directly`,
    }],
    total: 1,
    resume: action === "resume" ? 1 : 0,
    cancel: action === "cancel" ? 1 : 0,
    review: action === "review" ? 1 : 0,
    evaluatedAt: "2026-09-27T12:00:00.000Z",
  };
}

function admissionFor(record) {
  return {
    format: "nublox-metaobject-runtime-fleet-fair-dispatch",
    formatVersion: 1,
    admissionId: record.admissionId,
    revision: 1,
    status: "admitted",
    fairnessId: record.fairnessId,
    fairnessPolicyId: record.fairnessPolicyId,
    fairnessPolicyVersion: record.fairnessPolicyVersion,
    sourceEvaluationId: record.sourceEvaluationId,
    sourcePolicyId: "safety",
    sourcePolicyVersion: 1,
    dispatchId: record.dispatchId,
    workerId: record.workerId,
    work: record.work.map((item) => ({
      workId: item.workId,
      runtimeId: item.runtimeId,
      action: item.action,
      evaluatedRevision: item.workRevision,
      fairnessRank: item.fairnessRank,
      effectivePriority: 10,
      starved: false,
    })),
    admittedAt: "2026-09-27T12:00:01.000Z",
  };
}

function fixture(record, audit = auditFor(record)) {
  const audits = new Map([[audit.recoveryId, structuredClone(audit)]]);
  const reservations = new Map([[record.reservationId, structuredClone(record)]]);
  const admissions = new Map();
  const calls = [];
  const auditSource = {
    async get(id) { return audits.has(id) ? structuredClone(audits.get(id)) : null; },
  };
  const controller = {
    async get(id) { return reservations.has(id) ? structuredClone(reservations.get(id)) : null; },
    async history() { return [...reservations.values()].map((value) => structuredClone(value)); },
    async resume(id) {
      calls.push(["resume", id]);
      const current = reservations.get(id);
      const updated = {
        ...current,
        revision: current.revision + 1,
        status: "consumed",
        fairAdmissionStatus: "completed",
        dispatchOutcome: "completed",
        finishedAt: "2026-09-27T12:05:01.000Z",
      };
      reservations.set(id, updated);
      return { reservation: structuredClone(updated) };
    },
    async release(id, reason, expectedRevision) {
      calls.push(["release", id, reason, expectedRevision]);
      const current = reservations.get(id);
      const updated = {
        ...current,
        revision: current.revision + 1,
        status: "released",
        reason,
        finishedAt: "2026-09-27T12:05:01.000Z",
      };
      reservations.set(id, updated);
      return structuredClone(updated);
    },
  };
  const admissionSource = {
    async get(id) { return admissions.has(id) ? structuredClone(admissions.get(id)) : null; },
  };
  const store = new MemoryRuntimeFleetHandoffRecoveryResolutionStore();
  const catalog = new RuntimeFleetHandoffRecoveryResolutionCatalog(
    auditSource,
    controller,
    admissionSource,
    store,
    () => new Date("2026-09-27T12:05:00.000Z"),
  );
  return { catalog, store, audits, reservations, admissions, calls };
}

function request(record, audit, action, overrides = {}) {
  return {
    resolutionId: `resolution-${action}`,
    recoveryId: audit.recoveryId,
    reservationId: record.reservationId,
    action,
    actorId: "operator-1",
    reason: `${action} approved after review`,
    ...overrides,
  };
}

test("manual review can be durably resolved to resume and executed", async () => {
  const record = reservation("resume");
  const audit = auditFor(record);
  const { catalog, calls } = fixture(record, audit);

  const resolution = await catalog.resolve(request(record, audit, "resume"));
  assert.equal(resolution.action, "resume");
  assert.equal(resolution.actorId, "operator-1");

  const executed = await catalog.execute(resolution.resolutionId);
  assert.equal(executed.outcome, "resumed");
  assert.equal(executed.reservation.status, "consumed");
  assert.deepEqual(calls.map((call) => call[0]), ["resume"]);
});

test("manual review can be durably resolved to cancel through the M43-safe release path", async () => {
  const record = reservation("cancel");
  const audit = auditFor(record);
  const { catalog, calls } = fixture(record, audit);

  const resolution = await catalog.resolve(request(record, audit, "cancel"));
  const executed = await catalog.execute(resolution.resolutionId);

  assert.equal(executed.outcome, "cancelled");
  assert.equal(executed.reservation.status, "released");
  assert.equal(calls[0][0], "release");
  assert.match(calls[0][2], /M45 resolution/);
});

test("only M44 review decisions may be manually resolved", async () => {
  const record = reservation("direct");
  const audit = auditFor(record, "resume");
  const { catalog } = fixture(record, audit);

  await assert.rejects(
    () => catalog.resolve(request(record, audit, "cancel")),
    /not review/i,
  );
});

test("resolution and execution both fail closed when fenced state changes", async () => {
  const record = reservation("stale");
  const audit = auditFor(record);
  const first = fixture(record, audit);
  first.reservations.set(record.reservationId, { ...record, revision: record.revision + 1 });
  await assert.rejects(
    () => first.catalog.resolve(request(record, audit, "resume")),
    /changed after M44 recovery audit/i,
  );

  const second = fixture(record, audit);
  const resolution = await second.catalog.resolve(request(record, audit, "resume"));
  second.admissions.set(record.admissionId, admissionFor(record));
  await assert.rejects(
    () => second.catalog.execute(resolution.resolutionId),
    /appeared after M45 recovery resolution/i,
  );
});

test("resolution history is create-only, detached and filterable", async () => {
  const record = reservation("history");
  const audit = auditFor(record);
  const { catalog } = fixture(record, audit);
  const resolution = await catalog.resolve(request(record, audit, "resume", { resolutionId: "resolution-history" }));

  resolution.reason = "mutated";
  const persisted = await catalog.get("resolution-history");
  assert.notEqual(persisted.reason, "mutated");
  assert.equal((await catalog.history({ actorId: "operator-1" })).length, 1);
  assert.equal((await catalog.history({ action: "cancel" })).length, 0);

  await assert.rejects(
    () => catalog.resolve(request(record, audit, "resume", { resolutionId: "resolution-history" })),
    /already exists/i,
  );
});
