import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryRuntimeFleetFairDispatchStore,
  RuntimeFleetFairDispatcher,
} from "../dist/index.js";

function work(workId, runtimeId, action, revision = 1) {
  return {
    format: "nublox-metaobject-runtime-fleet-convergence-work",
    formatVersion: 1,
    workId,
    revision,
    reconciliationRunId: "reconcile-1",
    runtimeId,
    targetRevision: 1,
    action,
    reason: action,
    status: "pending",
    createdAt: "2026-09-27T09:00:00.000Z",
    updatedAt: "2026-09-27T09:00:00.000Z",
  };
}

function fairness(items) {
  return {
    format: "nublox-metaobject-runtime-fleet-convergence-fairness",
    formatVersion: 1,
    fairnessId: "fair-1",
    sourceEvaluationId: "queue-1",
    sourcePolicyId: "safety",
    sourcePolicyVersion: 3,
    fairnessPolicyId: "fairness",
    fairnessPolicyVersion: 1,
    historyDispatchIds: [],
    decisions: items.map((item, index) => ({
      workId: item.workId,
      runtimeId: item.runtimeId,
      action: item.action,
      workRevision: item.revision,
      basePriority: 10 - index,
      ageMs: 1000 + index,
      ageBoost: 0,
      recentRuntimeSelections: 0,
      recentActionSelections: 0,
      runtimePenalty: 0,
      actionPenalty: 0,
      effectivePriority: 10 - index,
      starved: index === 0,
      rank: index + 1,
    })),
    orderedWorkIds: items.map((item) => item.workId),
    starvedWorkIds: [items[0].workId],
    total: items.length,
    evaluatedAt: "2026-09-27T10:00:00.000Z",
  };
}

function dispatchRecord(dispatchId, workerId, items) {
  return {
    format: "nublox-metaobject-runtime-fleet-convergence-dispatch",
    formatVersion: 1,
    dispatchId,
    workerId,
    outcome: "completed",
    items: items.map((item) => ({
      workId: item.workId,
      runtimeId: item.runtimeId,
      action: item.action,
      workRevisionBefore: item.revision,
      status: "completed",
      finalWorkStatus: "completed",
    })),
    total: items.length,
    completed: items.length,
    blocked: 0,
    failed: 0,
    startedAt: "2026-09-27T11:00:00.000Z",
    completedAt: "2026-09-27T11:00:01.000Z",
  };
}

function fixture(items, dispatcherOverride) {
  const fairnessEvaluation = fairness(items);
  const fairnessSource = { async get(id) { return id === fairnessEvaluation.fairnessId ? structuredClone(fairnessEvaluation) : null; } };
  const byId = new Map(items.map((item) => [item.workId, structuredClone(item)]));
  const convergence = { async get(id) { return byId.has(id) ? structuredClone(byId.get(id)) : null; } };
  const records = new Map();
  const calls = [];
  const dispatcher = dispatcherOverride ?? {
    async get(id) { return records.has(id) ? structuredClone(records.get(id)) : null; },
    async dispatch(request) {
      calls.push(structuredClone(request));
      const selected = request.workIds.map((id) => byId.get(id));
      const record = dispatchRecord(request.dispatchId, request.workerId, selected);
      records.set(request.dispatchId, record);
      return structuredClone(record);
    },
  };
  const admissions = new MemoryRuntimeFleetFairDispatchStore();
  let tick = 0;
  const catalog = new RuntimeFleetFairDispatcher(
    fairnessSource,
    convergence,
    dispatcher,
    admissions,
    () => new Date(`2026-09-27T11:10:0${tick++}.000Z`),
  );
  return { catalog, admissions, byId, records, calls, fairnessEvaluation, dispatcher };
}

test("binds exact M39 ordering to M36 dispatch and preserves fairness provenance", async () => {
  const old = work("old-starved", "runtime-old", "reassess");
  const newer = work("new-high", "runtime-new", "review");
  const { catalog, calls } = fixture([old, newer]);

  const result = await catalog.dispatch({
    admissionId: "admission-1",
    fairnessId: "fair-1",
    dispatchId: "dispatch-1",
    workerId: "worker-a",
  });

  assert.equal(result.admission.status, "completed");
  assert.equal(result.admission.dispatchOutcome, "completed");
  assert.deepEqual(calls[0].workIds, ["old-starved", "new-high"]);
  assert.deepEqual(result.admission.work.map((item) => [item.workId, item.fairnessRank, item.starved]), [
    ["old-starved", 1, true],
    ["new-high", 2, false],
  ]);
});

test("maxItems truncates the fair order without re-sorting it", async () => {
  const one = work("one", "runtime-1", "review");
  const two = work("two", "runtime-2", "review");
  const three = work("three", "runtime-3", "review");
  const { catalog, calls } = fixture([one, two, three]);

  await catalog.dispatch({
    admissionId: "admission-limit",
    fairnessId: "fair-1",
    dispatchId: "dispatch-limit",
    workerId: "worker-a",
    maxItems: 2,
  });

  assert.deepEqual(calls[0].workIds, ["one", "two"]);
});

test("stale work is rejected before an admission or M36 dispatch is created", async () => {
  const item = work("stale", "runtime-a", "review");
  const { catalog, admissions, byId, calls } = fixture([item]);
  byId.set("stale", { ...item, revision: 2 });

  await assert.rejects(
    () => catalog.dispatch({
      admissionId: "admission-stale",
      fairnessId: "fair-1",
      dispatchId: "dispatch-stale",
      workerId: "worker-a",
    }),
    /changed from fairness revision/i,
  );
  assert.equal(await admissions.get("admission-stale"), null);
  assert.equal(calls.length, 0);
});

test("resume finalizes an already-created M36 dispatch without executing it again", async () => {
  const item = work("resume", "runtime-a", "review");
  const existing = dispatchRecord("dispatch-resume", "worker-a", [item]);
  let dispatchCalls = 0;
  const dispatcher = {
    async get(id) { return id === existing.dispatchId ? structuredClone(existing) : null; },
    async dispatch() { dispatchCalls += 1; throw new Error("must not execute"); },
  };
  const { catalog, admissions, fairnessEvaluation } = fixture([item], dispatcher);
  await admissions.create({
    format: "nublox-metaobject-runtime-fleet-fair-dispatch",
    formatVersion: 1,
    admissionId: "admission-resume",
    revision: 0,
    status: "admitted",
    fairnessId: fairnessEvaluation.fairnessId,
    fairnessPolicyId: fairnessEvaluation.fairnessPolicyId,
    fairnessPolicyVersion: fairnessEvaluation.fairnessPolicyVersion,
    sourceEvaluationId: fairnessEvaluation.sourceEvaluationId,
    sourcePolicyId: fairnessEvaluation.sourcePolicyId,
    sourcePolicyVersion: fairnessEvaluation.sourcePolicyVersion,
    dispatchId: "dispatch-resume",
    workerId: "worker-a",
    work: [{
      workId: item.workId,
      runtimeId: item.runtimeId,
      action: item.action,
      evaluatedRevision: item.revision,
      fairnessRank: 1,
      effectivePriority: 10,
      starved: true,
    }],
    admittedAt: "2026-09-27T11:00:00.000Z",
  });

  const resumed = await catalog.resume("admission-resume");
  assert.equal(resumed.admission.status, "completed");
  assert.equal(dispatchCalls, 0);
});

test("admission history is detached and terminal records are immutable", async () => {
  const item = work("immutable", "runtime-a", "review");
  const { catalog, admissions } = fixture([item]);
  const result = await catalog.dispatch({
    admissionId: "admission-immutable",
    fairnessId: "fair-1",
    dispatchId: "dispatch-immutable",
    workerId: "worker-a",
  });
  result.admission.work[0].workId = "mutated";
  assert.equal((await catalog.get("admission-immutable")).work[0].workId, "immutable");
  await assert.rejects(
    () => admissions.save(await admissions.get("admission-immutable"), 2),
    /terminal.*immutable/i,
  );
});
