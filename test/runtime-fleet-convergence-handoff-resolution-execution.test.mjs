import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryRuntimeFleetHandoffResolutionExecutionStore,
  RuntimeFleetHandoffResolutionExecutionCatalog,
} from "../dist/index.js";

function reservation(status = "handoff", revision = 2) {
  return {
    format: "nublox-metaobject-runtime-fleet-fair-reservation",
    formatVersion: 1,
    reservationId: "reservation-1",
    revision,
    status,
    fairnessId: "fair-1",
    fairnessPolicyId: "fairness",
    fairnessPolicyVersion: 1,
    sourceEvaluationId: "queue-1",
    admissionId: "admission-1",
    dispatchId: "dispatch-1",
    workerId: "worker-a",
    work: [{
      workId: "work-1",
      runtimeId: "runtime-1",
      action: "review",
      workRevision: 1,
      fairnessRank: 1,
    }],
    acquiredAt: "2026-09-27T10:00:00.000Z",
    expiresAt: "2026-09-27T10:01:00.000Z",
    handoffAt: "2026-09-27T11:58:00.000Z",
    ...(status === "consumed" ? {
      fairAdmissionStatus: "completed",
      dispatchOutcome: "completed",
      finishedAt: "2026-09-27T12:01:00.000Z",
    } : {}),
    ...(status === "released" ? {
      reason: "cancelled",
      finishedAt: "2026-09-27T12:01:00.000Z",
    } : {}),
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
    resolvedAt: "2026-09-27T12:00:00.000Z",
  };
}

function admitted(revision = 1) {
  return {
    format: "nublox-metaobject-runtime-fleet-fair-dispatch",
    formatVersion: 1,
    admissionId: "admission-1",
    revision,
    status: "admitted",
    fairnessId: "fair-1",
    fairnessPolicyId: "fairness",
    fairnessPolicyVersion: 1,
    sourceEvaluationId: "queue-1",
    sourcePolicyId: "safety",
    sourcePolicyVersion: 1,
    dispatchId: "dispatch-1",
    workerId: "worker-a",
    work: [{
      workId: "work-1",
      runtimeId: "runtime-1",
      action: "review",
      evaluatedRevision: 1,
      fairnessRank: 1,
      effectivePriority: 10,
      starved: false,
    }],
    admittedAt: "2026-09-27T12:00:30.000Z",
  };
}

function fixture({ action = "resume", execute } = {}) {
  const resolved = resolution(action);
  const reservations = new Map([[resolved.reservationId, reservation()]]);
  const admissions = new Map();
  let executeCalls = 0;
  const resolutions = {
    async get(id) { return id === resolved.resolutionId ? structuredClone(resolved) : null; },
    async execute(id) {
      executeCalls += 1;
      if (execute) return execute({ id, resolved, reservations, admissions, executeCalls });
      const current = reservations.get(resolved.reservationId);
      const finalStatus = resolved.action === "resume" ? "consumed" : "released";
      const final = reservation(finalStatus, current.revision + 1);
      reservations.set(resolved.reservationId, final);
      return {
        outcome: resolved.action === "resume" ? "resumed" : "cancelled",
        resolution: structuredClone(resolved),
        reservation: structuredClone(final),
      };
    },
  };
  const reservationSource = {
    async get(id) { return reservations.has(id) ? structuredClone(reservations.get(id)) : null; },
  };
  const admissionSource = {
    async get(id) { return admissions.has(id) ? structuredClone(admissions.get(id)) : null; },
  };
  const store = new MemoryRuntimeFleetHandoffResolutionExecutionStore();
  let tick = 0;
  const catalog = new RuntimeFleetHandoffResolutionExecutionCatalog(
    resolutions,
    reservationSource,
    admissionSource,
    store,
    () => new Date(`2026-09-27T12:05:0${tick++}.000Z`),
  );
  return {
    catalog,
    store,
    resolved,
    reservations,
    admissions,
    getExecuteCalls: () => executeCalls,
  };
}

test("persists a running receipt before M45 and completes with final fencing evidence", async () => {
  let sawRunning = false;
  let fixtureRef;
  const setup = fixture({
    execute: async ({ resolved, reservations }) => {
      sawRunning = (await fixtureRef.store.get("execution-1"))?.status === "running";
      const final = reservation("consumed", 3);
      reservations.set(resolved.reservationId, final);
      return { outcome: "resumed", resolution: structuredClone(resolved), reservation: structuredClone(final) };
    },
  });
  fixtureRef = setup;

  const result = await setup.catalog.run({ executionId: "execution-1", resolutionId: setup.resolved.resolutionId });

  assert.equal(sawRunning, true);
  assert.equal(result.status, "completed");
  assert.equal(result.outcome, "resumed");
  assert.equal(result.finalReservationStatus, "consumed");
  assert.equal(result.finalReservationRevision, 3);
});

test("unchanged fencing state after an execution error becomes an explicit failed receipt", async () => {
  const { catalog, resolved } = fixture({
    execute: async () => { throw new Error("executor unavailable"); },
  });

  const result = await catalog.run({ executionId: "execution-failed", resolutionId: resolved.resolutionId });

  assert.equal(result.status, "failed");
  assert.match(result.error, /executor unavailable/i);
  assert.equal(result.finalReservationStatus, "handoff");
  assert.equal(result.finalReservationRevision, 2);
});

test("lost response after terminal reservation mutation is reconciled as completed", async () => {
  const { catalog, resolved } = fixture({
    action: "cancel",
    execute: async ({ resolved, reservations }) => {
      reservations.set(resolved.reservationId, reservation("released", 3));
      throw new Error("response lost after release");
    },
  });

  const result = await catalog.run({ executionId: "execution-reconciled", resolutionId: resolved.resolutionId });

  assert.equal(result.status, "completed");
  assert.equal(result.outcome, "cancelled");
  assert.equal(result.finalReservationStatus, "released");
});

test("resume safely retries a running receipt when the exact starting snapshot is unchanged", async () => {
  const setup = fixture();
  await setup.store.create({
    format: "nublox-metaobject-runtime-fleet-handoff-resolution-execution",
    formatVersion: 1,
    executionId: "execution-running",
    revision: 0,
    status: "running",
    resolutionId: setup.resolved.resolutionId,
    recoveryId: setup.resolved.recoveryId,
    reservationId: setup.resolved.reservationId,
    action: setup.resolved.action,
    actorId: setup.resolved.actorId,
    startReservationRevision: 2,
    admissionId: setup.resolved.admissionId,
    startedAt: "2026-09-27T12:04:00.000Z",
  });

  const result = await setup.catalog.resume("execution-running");

  assert.equal(setup.getExecuteCalls(), 1);
  assert.equal(result.status, "completed");
  assert.equal(result.outcome, "resumed");
});

test("resume marks changed non-terminal fencing state uncertain instead of replaying M45", async () => {
  const setup = fixture();
  await setup.store.create({
    format: "nublox-metaobject-runtime-fleet-handoff-resolution-execution",
    formatVersion: 1,
    executionId: "execution-uncertain",
    revision: 0,
    status: "running",
    resolutionId: setup.resolved.resolutionId,
    recoveryId: setup.resolved.recoveryId,
    reservationId: setup.resolved.reservationId,
    action: setup.resolved.action,
    actorId: setup.resolved.actorId,
    startReservationRevision: 2,
    admissionId: setup.resolved.admissionId,
    startedAt: "2026-09-27T12:04:00.000Z",
  });
  setup.admissions.set("admission-1", admitted());

  const result = await setup.catalog.resume("execution-uncertain");

  assert.equal(setup.getExecuteCalls(), 0);
  assert.equal(result.status, "uncertain");
  assert.equal(result.finalAdmissionStatus, "admitted");
  assert.match(result.error, /fresh M44\/M45 decision/i);
});

test("terminal execution receipts are detached and immutable", async () => {
  const setup = fixture();
  const result = await setup.catalog.run({ executionId: "execution-history", resolutionId: setup.resolved.resolutionId });
  result.error = "mutated";
  const persisted = await setup.catalog.get("execution-history");
  assert.equal(persisted.status, "completed");
  assert.equal(persisted.error, undefined);
  await assert.rejects(
    () => setup.store.save(persisted, persisted.revision),
    /terminal.*immutable/i,
  );
});
