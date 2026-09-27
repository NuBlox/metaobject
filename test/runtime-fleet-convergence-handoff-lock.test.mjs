import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryRuntimeFleetFairReservationStore,
  RuntimeFleetFairReservationCatalog,
} from "../dist/index.js";

function work(workId = "one", revision = 1) {
  return {
    format: "nublox-metaobject-runtime-fleet-convergence-work",
    formatVersion: 1,
    workId,
    revision,
    reconciliationRunId: "reconcile-1",
    runtimeId: `runtime-${workId}`,
    targetRevision: 1,
    action: "review",
    reason: "review",
    status: "pending",
    createdAt: "2026-09-27T10:00:00.000Z",
    updatedAt: "2026-09-27T10:00:00.000Z",
  };
}

function fairness(item) {
  return {
    format: "nublox-metaobject-runtime-fleet-convergence-fairness",
    formatVersion: 1,
    fairnessId: "fair-1",
    sourceEvaluationId: "queue-1",
    sourcePolicyId: "safety",
    sourcePolicyVersion: 1,
    fairnessPolicyId: "fairness",
    fairnessPolicyVersion: 1,
    historyDispatchIds: [],
    decisions: [{
      workId: item.workId,
      runtimeId: item.runtimeId,
      action: item.action,
      workRevision: item.revision,
      basePriority: 10,
      ageMs: 1000,
      ageBoost: 0,
      recentRuntimeSelections: 0,
      recentActionSelections: 0,
      runtimePenalty: 0,
      actionPenalty: 0,
      effectivePriority: 10,
      starved: false,
      rank: 1,
    }],
    orderedWorkIds: [item.workId],
    starvedWorkIds: [],
    total: 1,
    evaluatedAt: "2026-09-27T10:30:00.000Z",
  };
}

function admission(request, item) {
  return {
    format: "nublox-metaobject-runtime-fleet-fair-dispatch",
    formatVersion: 1,
    admissionId: request.admissionId,
    revision: 2,
    status: "completed",
    fairnessId: request.fairnessId,
    fairnessPolicyId: "fairness",
    fairnessPolicyVersion: 1,
    sourceEvaluationId: "queue-1",
    sourcePolicyId: "safety",
    sourcePolicyVersion: 1,
    dispatchId: request.dispatchId,
    workerId: request.workerId,
    work: [{
      workId: item.workId,
      runtimeId: item.runtimeId,
      action: item.action,
      evaluatedRevision: item.revision,
      fairnessRank: 1,
      effectivePriority: 10,
      starved: false,
    }],
    dispatchOutcome: "completed",
    admittedAt: "2026-09-27T11:00:00.000Z",
    finishedAt: "2026-09-27T11:00:01.000Z",
  };
}

function cancelledAdmission(request, item) {
  const value = admission(request, item);
  delete value.dispatchOutcome;
  return {
    ...value,
    revision: 1,
    status: "cancelled",
    reason: request.reason,
  };
}

function request(overrides = {}) {
  return {
    reservationId: "reservation-1",
    fairnessId: "fair-1",
    admissionId: "admission-1",
    dispatchId: "dispatch-1",
    workerId: "worker-a",
    leaseMs: 1000,
    ...overrides,
  };
}

function fixture({ dispatcher } = {}) {
  const item = work();
  const fair = fairness(item);
  const fairnessSource = { async get(id) { return id === fair.fairnessId ? structuredClone(fair) : null; } };
  const byId = new Map([[item.workId, structuredClone(item)]]);
  const convergence = { async get(id) { return byId.has(id) ? structuredClone(byId.get(id)) : null; } };
  const reservations = new MemoryRuntimeFleetFairReservationStore();
  const admissions = new Map();
  let now = Date.parse("2026-09-27T11:00:00.000Z");
  const clock = () => new Date(now);
  const setNow = (value) => { now = Date.parse(value); };
  const defaultDispatcher = {
    async get(id) { return admissions.has(id) ? structuredClone(admissions.get(id)) : null; },
    async dispatch(dispatchRequest) {
      const value = admission(dispatchRequest, item);
      admissions.set(dispatchRequest.admissionId, value);
      return { admission: structuredClone(value) };
    },
    async cancel(cancelRequest) {
      const value = cancelledAdmission(cancelRequest, item);
      admissions.set(cancelRequest.admissionId, value);
      return structuredClone(value);
    },
    async resume(id) {
      const value = admissions.get(id);
      if (!value) throw new Error("missing admission");
      return { admission: structuredClone(value) };
    },
  };
  const fairDispatcher = dispatcher?.({ item, admissions }) ?? defaultDispatcher;
  const catalog = new RuntimeFleetFairReservationCatalog(
    fairnessSource,
    convergence,
    reservations,
    fairDispatcher,
    clock,
  );
  return { catalog, reservations, admissions, byId, item, fairDispatcher, setNow };
}

test("handoff lock remains exclusive after the finite lease expires while M40 is running", async () => {
  let releaseDispatch;
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const { catalog, setNow, item } = fixture({
    dispatcher: ({ admissions }) => ({
      async get(id) { return admissions.has(id) ? structuredClone(admissions.get(id)) : null; },
      async dispatch(dispatchRequest) {
        startedResolve();
        return new Promise((resolve) => {
          releaseDispatch = () => {
            const value = admission(dispatchRequest, item);
            admissions.set(dispatchRequest.admissionId, value);
            resolve({ admission: structuredClone(value) });
          };
        });
      },
      async cancel(cancelRequest) {
        const value = cancelledAdmission(cancelRequest, item);
        admissions.set(cancelRequest.admissionId, value);
        return structuredClone(value);
      },
      async resume(id) {
        const value = admissions.get(id);
        return { admission: structuredClone(value) };
      },
    }),
  });

  await catalog.reserve(request());
  const running = catalog.dispatch("reservation-1");
  await started;
  const locked = await catalog.get("reservation-1");
  assert.equal(locked.status, "handoff");
  assert.ok(locked.handoffAt);

  setNow("2026-09-27T11:05:00.000Z");
  await assert.rejects(
    () => catalog.reserve(request({
      reservationId: "reservation-2",
      admissionId: "admission-2",
      dispatchId: "dispatch-2",
    })),
    /handoff-locked by 'reservation-1'/i,
  );

  releaseDispatch();
  const completed = await running;
  assert.equal(completed.reservation.status, "consumed");
});

test("a crashed handoff resumes after lease expiry when M40 admission was never created", async () => {
  let fail = true;
  const { catalog, setNow, admissions, item } = fixture({
    dispatcher: () => ({
      async get(id) { return admissions.has(id) ? structuredClone(admissions.get(id)) : null; },
      async dispatch(dispatchRequest) {
        if (fail) throw new Error("process stopped before M40 admission");
        const value = admission(dispatchRequest, item);
        admissions.set(dispatchRequest.admissionId, value);
        return { admission: structuredClone(value) };
      },
      async cancel(cancelRequest) {
        const value = cancelledAdmission(cancelRequest, item);
        admissions.set(cancelRequest.admissionId, value);
        return structuredClone(value);
      },
      async resume(id) { return { admission: structuredClone(admissions.get(id)) }; },
    }),
  });

  await catalog.reserve(request());
  await assert.rejects(() => catalog.dispatch("reservation-1"), /process stopped/i);
  assert.equal((await catalog.get("reservation-1")).status, "handoff");

  setNow("2026-09-27T11:10:00.000Z");
  fail = false;
  const resumed = await catalog.resume("reservation-1");
  assert.equal(resumed.reservation.status, "consumed");
});

test("handoff release creates a cancellation fence before freeing work", async () => {
  const { catalog, admissions, item } = fixture({
    dispatcher: () => ({
      async get(id) { return admissions.has(id) ? structuredClone(admissions.get(id)) : null; },
      async dispatch() { throw new Error("stop before admission"); },
      async cancel(cancelRequest) {
        const value = cancelledAdmission(cancelRequest, item);
        admissions.set(cancelRequest.admissionId, value);
        return structuredClone(value);
      },
      async resume(id) { return { admission: structuredClone(admissions.get(id)) }; },
    }),
  });

  await catalog.reserve(request());
  await assert.rejects(() => catalog.dispatch("reservation-1"), /stop before admission/i);
  const handoff = await catalog.get("reservation-1");
  assert.equal(handoff.status, "handoff");

  const released = await catalog.release("reservation-1", "operator abandoned handoff", handoff.revision);
  assert.equal(released.status, "released");
  assert.equal(admissions.get("admission-1").status, "cancelled");

  const second = await catalog.reserve(request({
    reservationId: "reservation-2",
    admissionId: "admission-2",
    dispatchId: "dispatch-2",
  }));
  assert.equal(second.status, "active");
});

test("handoff release is rejected when normal M40 admission already won", async () => {
  const { catalog, admissions, item } = fixture();
  const reserved = await catalog.reserve(request());
  const handoff = await catalog.get(reserved.reservationId);
  admissions.set("admission-1", admission(request(), item));

  await assert.rejects(
    () => catalog.release("reservation-1", "unsafe", handoff.revision),
    /already has M40 admission/i,
  );
});

test("legacy expired lease cannot enter handoff after newer ownership was acquired", async () => {
  const { catalog, reservations, setNow } = fixture();
  const old = await catalog.reserve(request({ leaseMs: 1000 }));
  setNow("2026-09-27T11:02:00.000Z");
  await catalog.reserve(request({
    reservationId: "reservation-2",
    admissionId: "admission-2",
    dispatchId: "dispatch-2",
    leaseMs: 60_000,
  }));

  await assert.rejects(
    () => reservations.save({
      ...old,
      status: "handoff",
      handoffAt: "2026-09-27T11:02:01.000Z",
    }, old.revision),
    /reserved by 'reservation-2'/i,
  );
});