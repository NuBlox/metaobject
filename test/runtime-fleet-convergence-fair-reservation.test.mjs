import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryRuntimeFleetFairReservationStore,
  RuntimeFleetFairReservationCatalog,
} from "../dist/index.js";

function work(workId, runtimeId = `runtime-${workId}`, revision = 1) {
  return {
    format: "nublox-metaobject-runtime-fleet-convergence-work",
    formatVersion: 1,
    workId,
    revision,
    reconciliationRunId: "reconcile-1",
    runtimeId,
    targetRevision: 1,
    action: "review",
    reason: "review",
    status: "pending",
    createdAt: "2026-09-27T10:00:00.000Z",
    updatedAt: "2026-09-27T10:00:00.000Z",
  };
}

function fairness(items) {
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
    decisions: items.map((item, index) => ({
      workId: item.workId,
      runtimeId: item.runtimeId,
      action: item.action,
      workRevision: item.revision,
      basePriority: 10 - index,
      ageMs: 1000,
      ageBoost: 0,
      recentRuntimeSelections: 0,
      recentActionSelections: 0,
      runtimePenalty: 0,
      actionPenalty: 0,
      effectivePriority: 10 - index,
      starved: false,
      rank: index + 1,
    })),
    orderedWorkIds: items.map((item) => item.workId),
    starvedWorkIds: [],
    total: items.length,
    evaluatedAt: "2026-09-27T10:30:00.000Z",
  };
}

function fairAdmission(request, items, status = "completed") {
  return {
    format: "nublox-metaobject-runtime-fleet-fair-dispatch",
    formatVersion: 1,
    admissionId: request.admissionId,
    revision: 2,
    status,
    fairnessId: request.fairnessId,
    fairnessPolicyId: "fairness",
    fairnessPolicyVersion: 1,
    sourceEvaluationId: "queue-1",
    sourcePolicyId: "safety",
    sourcePolicyVersion: 1,
    dispatchId: request.dispatchId,
    workerId: request.workerId,
    work: items.map((item, index) => ({
      workId: item.workId,
      runtimeId: item.runtimeId,
      action: item.action,
      evaluatedRevision: item.revision,
      fairnessRank: index + 1,
      effectivePriority: 10 - index,
      starved: false,
    })),
    ...(status === "completed" ? { dispatchOutcome: "completed" } : { error: "failed" }),
    admittedAt: "2026-09-27T11:00:00.000Z",
    finishedAt: "2026-09-27T11:00:01.000Z",
  };
}

function fixture(items, times = ["2026-09-27T11:00:00.000Z"]) {
  const fair = fairness(items);
  const fairnessSource = { async get(id) { return id === fair.fairnessId ? structuredClone(fair) : null; } };
  const byId = new Map(items.map((item) => [item.workId, structuredClone(item)]));
  const convergence = { async get(id) { return byId.has(id) ? structuredClone(byId.get(id)) : null; } };
  const admissions = new Map();
  const calls = [];
  const fairDispatcher = {
    async get(id) { return admissions.has(id) ? structuredClone(admissions.get(id)) : null; },
    async dispatch(request) {
      calls.push(["dispatch", structuredClone(request)]);
      const selected = items.slice(0, request.maxItems);
      const admission = fairAdmission(request, selected);
      admissions.set(request.admissionId, admission);
      return { admission: structuredClone(admission), dispatch: { outcome: "completed" } };
    },
    async resume(id) {
      calls.push(["resume", id]);
      const admission = admissions.get(id);
      if (!admission) throw new Error("missing admission");
      return { admission: structuredClone(admission), dispatch: { outcome: "completed" } };
    },
  };
  const reservations = new MemoryRuntimeFleetFairReservationStore();
  let tick = 0;
  const clock = () => new Date(times[Math.min(tick++, times.length - 1)]);
  const catalog = new RuntimeFleetFairReservationCatalog(
    fairnessSource,
    convergence,
    reservations,
    fairDispatcher,
    clock,
  );
  return { catalog, reservations, fairDispatcher, fairnessSource, byId, admissions, calls, fair };
}

function reservationRequest(overrides = {}) {
  return {
    reservationId: "reservation-1",
    fairnessId: "fair-1",
    admissionId: "admission-1",
    dispatchId: "dispatch-1",
    workerId: "worker-a",
    leaseMs: 60_000,
    ...overrides,
  };
}

test("atomically prevents overlapping active reservations for the same fair work", async () => {
  const item = work("one");
  const { catalog } = fixture([item], ["2026-09-27T11:00:00.000Z", "2026-09-27T11:00:10.000Z"]);
  const first = await catalog.reserve(reservationRequest());
  assert.equal(first.status, "active");
  assert.equal(first.revision, 1);

  await assert.rejects(
    () => catalog.reserve(reservationRequest({
      reservationId: "reservation-2",
      admissionId: "admission-2",
      dispatchId: "dispatch-2",
    })),
    /reserved by 'reservation-1'/i,
  );
});

test("expired active leases stop blocking later acquisitions without rewriting history", async () => {
  const item = work("one");
  const { catalog } = fixture([item], ["2026-09-27T11:00:00.000Z", "2026-09-27T11:02:00.000Z"]);
  const first = await catalog.reserve(reservationRequest({ leaseMs: 30_000 }));
  const second = await catalog.reserve(reservationRequest({
    reservationId: "reservation-2",
    admissionId: "admission-2",
    dispatchId: "dispatch-2",
  }));
  assert.equal(first.status, "active");
  assert.equal(second.status, "active");
  assert.equal((await catalog.get("reservation-1")).status, "active");
});

test("dispatch consumes the lease and binds it to the exact M40 admission", async () => {
  const items = [work("one"), work("two")];
  const { catalog, calls } = fixture(items, [
    "2026-09-27T11:00:00.000Z",
    "2026-09-27T11:00:01.000Z",
    "2026-09-27T11:00:02.000Z",
  ]);
  await catalog.reserve(reservationRequest());
  const result = await catalog.dispatch("reservation-1");

  assert.equal(result.reservation.status, "consumed");
  assert.equal(result.reservation.fairAdmissionStatus, "completed");
  assert.equal(result.reservation.dispatchOutcome, "completed");
  assert.deepEqual(result.reservation.work.map((item) => item.workId), ["one", "two"]);
  assert.equal(calls[0][0], "dispatch");
  assert.equal(calls[0][1].admissionId, "admission-1");
});

test("stale reserved work is rejected before M40 dispatch", async () => {
  const item = work("one");
  const { catalog, byId, calls } = fixture([item], ["2026-09-27T11:00:00.000Z", "2026-09-27T11:00:01.000Z"]);
  await catalog.reserve(reservationRequest());
  byId.set("one", { ...item, revision: 2 });

  await assert.rejects(() => catalog.dispatch("reservation-1"), /changed after reservation acquisition/i);
  assert.equal(calls.length, 0);
  assert.equal((await catalog.get("reservation-1")).status, "active");
});

test("resume consumes an expired lease when its exact M40 admission already exists", async () => {
  const item = work("one");
  const { catalog, admissions, calls } = fixture([item], [
    "2026-09-27T11:00:00.000Z",
    "2026-09-27T11:02:00.000Z",
    "2026-09-27T11:02:01.000Z",
  ]);
  await catalog.reserve(reservationRequest({ leaseMs: 30_000 }));
  admissions.set("admission-1", fairAdmission(reservationRequest(), [item]));

  const result = await catalog.resume("reservation-1");
  assert.equal(result.reservation.status, "consumed");
  assert.equal(calls[0][0], "resume");
});

test("release frees work for another reservation and becomes immutable", async () => {
  const item = work("one");
  const { catalog, reservations } = fixture([item], [
    "2026-09-27T11:00:00.000Z",
    "2026-09-27T11:00:01.000Z",
    "2026-09-27T11:00:02.000Z",
    "2026-09-27T11:00:03.000Z",
  ]);
  const first = await catalog.reserve(reservationRequest());
  const released = await catalog.release(first.reservationId, "operator cancelled", first.revision);
  assert.equal(released.status, "released");
  const second = await catalog.reserve(reservationRequest({
    reservationId: "reservation-2",
    admissionId: "admission-2",
    dispatchId: "dispatch-2",
  }));
  assert.equal(second.status, "active");
  await assert.rejects(() => reservations.save(released, released.revision), /terminal.*immutable/i);
});
