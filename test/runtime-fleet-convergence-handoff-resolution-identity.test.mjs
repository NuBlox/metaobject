import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryRuntimeFleetHandoffResolutionExecutionStore,
  RuntimeFleetHandoffResolutionExecutionCatalog,
} from "../dist/index.js";

function reservation(status = "handoff", revision = 2, overrides = {}) {
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
    ...overrides,
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

function fixture({ action = "resume", execute } = {}) {
  const resolved = resolution(action);
  const reservations = new Map([[resolved.reservationId, reservation()]]);
  const admissions = new Map();
  const resolutions = {
    async get(id) { return id === resolved.resolutionId ? structuredClone(resolved) : null; },
    async execute(id) {
      if (execute) return execute({ id, resolved, reservations, admissions });
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
  return { catalog, store, resolved, reservations, admissions };
}

test("new M46 receipts freeze the full immutable M42 handoff identity", async () => {
  let captured;
  let setup;
  setup = fixture({
    execute: async ({ resolved, reservations }) => {
      captured = await setup.store.get("execution-identity");
      const final = reservation("consumed", 3);
      reservations.set(resolved.reservationId, final);
      return { outcome: "resumed", resolution: structuredClone(resolved), reservation: structuredClone(final) };
    },
  });

  const result = await setup.catalog.run({ executionId: "execution-identity", resolutionId: setup.resolved.resolutionId });

  assert.equal(result.status, "completed");
  assert.equal(captured.handoffIdentity.dispatchId, "dispatch-1");
  assert.equal(captured.handoffIdentity.workerId, "worker-a");
  assert.equal(captured.handoffIdentity.handoffAt, "2026-09-27T11:58:00.000Z");
  assert.deepEqual(captured.handoffIdentity.work, [{
    workId: "work-1",
    runtimeId: "runtime-1",
    action: "review",
    workRevision: 1,
    fairnessRank: 1,
  }]);
});

test("lost-response reconciliation rejects a terminal reservation with changed worker identity", async () => {
  const setup = fixture({
    execute: async ({ resolved, reservations }) => {
      reservations.set(resolved.reservationId, reservation("consumed", 3, { workerId: "worker-forged" }));
      throw new Error("response lost");
    },
  });

  const result = await setup.catalog.run({ executionId: "execution-worker-forged", resolutionId: setup.resolved.resolutionId });

  assert.equal(result.status, "uncertain");
  assert.match(result.error, /immutable handoff identity changed/i);
});

test("lost-response reconciliation rejects a terminal reservation with changed ordered work identity", async () => {
  const setup = fixture({
    execute: async ({ resolved, reservations }) => {
      reservations.set(resolved.reservationId, reservation("consumed", 3, {
        work: [{
          workId: "work-other",
          runtimeId: "runtime-1",
          action: "review",
          workRevision: 1,
          fairnessRank: 1,
        }],
      }));
      throw new Error("response lost");
    },
  });

  const result = await setup.catalog.run({ executionId: "execution-work-forged", resolutionId: setup.resolved.resolutionId });

  assert.equal(result.status, "uncertain");
  assert.match(result.error, /immutable handoff identity changed/i);
});

test("legacy v0.46 running receipts without handoffIdentity remain readable and recoverable", async () => {
  const setup = fixture();
  await setup.store.create({
    format: "nublox-metaobject-runtime-fleet-handoff-resolution-execution",
    formatVersion: 1,
    executionId: "execution-legacy",
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
  setup.reservations.set(setup.resolved.reservationId, reservation("consumed", 3));

  const result = await setup.catalog.resume("execution-legacy");

  assert.equal(result.status, "completed");
  assert.equal(result.outcome, "resumed");
});

test("handoff identity is immutable inside a running execution receipt", async () => {
  const setup = fixture();
  const stored = await setup.store.create({
    format: "nublox-metaobject-runtime-fleet-handoff-resolution-execution",
    formatVersion: 1,
    executionId: "execution-immutable-identity",
    revision: 0,
    status: "running",
    resolutionId: setup.resolved.resolutionId,
    recoveryId: setup.resolved.recoveryId,
    reservationId: setup.resolved.reservationId,
    action: setup.resolved.action,
    actorId: setup.resolved.actorId,
    startReservationRevision: 2,
    admissionId: setup.resolved.admissionId,
    handoffIdentity: {
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
    },
    startedAt: "2026-09-27T12:04:00.000Z",
  });

  await assert.rejects(
    () => setup.store.save({
      ...stored,
      handoffIdentity: { ...stored.handoffIdentity, workerId: "worker-b" },
    }, stored.revision),
    /handoffIdentity is immutable/i,
  );
});
