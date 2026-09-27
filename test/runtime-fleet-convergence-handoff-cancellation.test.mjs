import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryRuntimeFleetFairDispatchStore,
  RuntimeFleetFairDispatcher,
} from "../dist/index.js";

function work() {
  return {
    format: "nublox-metaobject-runtime-fleet-convergence-work",
    formatVersion: 1,
    workId: "one",
    revision: 1,
    reconciliationRunId: "reconcile-1",
    runtimeId: "runtime-one",
    targetRevision: 1,
    action: "review",
    reason: "review",
    status: "pending",
    createdAt: "2026-09-27T09:00:00.000Z",
    updatedAt: "2026-09-27T09:00:00.000Z",
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
    evaluatedAt: "2026-09-27T10:00:00.000Z",
  };
}

function dispatchRecord(request, item) {
  return {
    format: "nublox-metaobject-runtime-fleet-convergence-dispatch",
    formatVersion: 1,
    dispatchId: request.dispatchId,
    workerId: request.workerId,
    outcome: "completed",
    items: [{
      workId: item.workId,
      runtimeId: item.runtimeId,
      action: item.action,
      workRevisionBefore: item.revision,
      status: "completed",
      finalWorkStatus: "completed",
    }],
    total: 1,
    completed: 1,
    blocked: 0,
    failed: 0,
    startedAt: "2026-09-27T11:00:00.000Z",
    completedAt: "2026-09-27T11:00:01.000Z",
  };
}

function fixture() {
  const item = work();
  const fair = fairness(item);
  const byId = new Map([[item.workId, structuredClone(item)]]);
  const records = new Map();
  let dispatchCalls = 0;
  const dispatcher = {
    async get(id) { return records.has(id) ? structuredClone(records.get(id)) : null; },
    async dispatch(request) {
      dispatchCalls += 1;
      const record = dispatchRecord(request, item);
      records.set(request.dispatchId, record);
      return structuredClone(record);
    },
  };
  const admissions = new MemoryRuntimeFleetFairDispatchStore();
  let tick = 0;
  const catalog = new RuntimeFleetFairDispatcher(
    { async get(id) { return id === fair.fairnessId ? structuredClone(fair) : null; } },
    { async get(id) { return byId.has(id) ? structuredClone(byId.get(id)) : null; } },
    dispatcher,
    admissions,
    () => new Date(`2026-09-27T11:10:0${tick++}.000Z`),
  );
  return { catalog, admissions, records, item, dispatchCalls: () => dispatchCalls };
}

function request(overrides = {}) {
  return {
    admissionId: "admission-1",
    fairnessId: "fair-1",
    dispatchId: "dispatch-1",
    workerId: "worker-a",
    maxItems: 1,
    ...overrides,
  };
}

test("cancellation tombstone prevents a stale worker from later dispatching the same admission", async () => {
  const { catalog, dispatchCalls } = fixture();
  const cancelled = await catalog.cancel({ ...request(), reason: "operator abandoned handoff" });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.reason, "operator abandoned handoff");
  assert.equal(dispatchCalls(), 0);

  await assert.rejects(
    () => catalog.dispatch(request()),
    /already exists/i,
  );
  assert.equal(dispatchCalls(), 0);
});

test("normal admission wins the race and cannot be retroactively cancelled", async () => {
  const { catalog, dispatchCalls } = fixture();
  const result = await catalog.dispatch(request());
  assert.equal(result.admission.status, "completed");
  assert.equal(dispatchCalls(), 1);

  await assert.rejects(
    () => catalog.cancel({ ...request(), reason: "too late" }),
    /already 'completed'.*cannot be cancelled/i,
  );
});

test("cancellation is idempotent only for the same immutable handoff identity", async () => {
  const { catalog } = fixture();
  const first = await catalog.cancel({ ...request(), reason: "abandon" });
  const second = await catalog.cancel({ ...request(), reason: "repeat" });
  assert.equal(second.admissionId, first.admissionId);
  assert.equal(second.status, "cancelled");

  await assert.rejects(
    () => catalog.cancel({ ...request({ workerId: "worker-b" }), reason: "mismatch" }),
    /does not match the cancellation request/i,
  );
});