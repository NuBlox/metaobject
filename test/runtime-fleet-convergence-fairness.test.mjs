import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryRuntimeFleetConvergenceFairnessStore,
  RuntimeFleetConvergenceFairnessCatalog,
  validateRuntimeFleetConvergenceFairnessPolicy,
} from "../dist/index.js";

function work(workId, runtimeId, action, createdAt, revision = 1) {
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
    createdAt,
    updatedAt: createdAt,
  };
}

function queueEvaluation(decisions) {
  return {
    format: "nublox-metaobject-runtime-fleet-convergence-queue-evaluation",
    formatVersion: 1,
    evaluationId: "queue-1",
    policyId: "safety",
    policyVersion: 3,
    decisions,
    eligibleWorkIds: decisions.filter((decision) => decision.status === "eligible").map((decision) => decision.workId),
    total: decisions.length,
    eligible: decisions.filter((decision) => decision.status === "eligible").length,
    blocked: decisions.filter((decision) => decision.status === "blocked").length,
    evaluatedAt: "2026-09-27T11:00:00.000Z",
  };
}

function decision(item, priority) {
  return {
    workId: item.workId,
    runtimeId: item.runtimeId,
    action: item.action,
    workRevision: item.revision,
    priority,
    status: "eligible",
    blockReasons: [],
    details: [],
  };
}

function dispatch(dispatchId, items, completedAt) {
  return {
    format: "nublox-metaobject-runtime-fleet-convergence-dispatch",
    formatVersion: 1,
    dispatchId,
    workerId: "worker",
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
    startedAt: completedAt,
    completedAt,
  };
}

function fixture(items, priorities, history = []) {
  const byId = new Map(items.map((item) => [item.workId, structuredClone(item)]));
  const source = queueEvaluation(items.map((item) => decision(item, priorities[item.workId] ?? 0)));
  const queueSource = { async get(id) { return id === source.evaluationId ? structuredClone(source) : null; } };
  const convergence = { async get(id) { return byId.has(id) ? structuredClone(byId.get(id)) : null; } };
  const dispatches = { async list() { return structuredClone(history); } };
  const evaluations = new MemoryRuntimeFleetConvergenceFairnessStore();
  const catalog = new RuntimeFleetConvergenceFairnessCatalog(
    queueSource,
    convergence,
    dispatches,
    evaluations,
    () => new Date("2026-09-27T12:00:00.000Z"),
  );
  return { catalog, evaluations, byId, source };
}

test("starvation promotion prevents old low-priority work from being permanently suppressed", async () => {
  const newer = work("new-high", "runtime-new", "review", "2026-09-27T11:50:00.000Z");
  const old = work("old-low", "runtime-old", "reassess", "2026-09-27T08:00:00.000Z");
  const { catalog } = fixture([newer, old], { "new-high": 20, "old-low": 0 });

  const result = await catalog.evaluate({
    fairnessId: "fair-1",
    sourceEvaluationId: "queue-1",
    policy: {
      policyId: "fairness",
      version: 1,
      ageBoostStepMs: 30 * 60 * 1000,
      ageBoostPerStep: 2,
      starvationThresholdMs: 2 * 60 * 60 * 1000,
    },
  });

  assert.deepEqual(result.orderedWorkIds, ["old-low", "new-high"]);
  assert.deepEqual(result.starvedWorkIds, ["old-low"]);
  assert.equal(result.decisions[0].starved, true);
  assert.ok(result.decisions[0].ageBoost > 0);
});

test("recent runtime service is penalized so quieter runtimes receive fairer access", async () => {
  const a = work("a-next", "runtime-a", "reassess", "2026-09-27T11:30:00.000Z");
  const b = work("b-next", "runtime-b", "reassess", "2026-09-27T11:30:00.000Z");
  const previousA1 = work("a-old-1", "runtime-a", "reassess", "2026-09-27T10:00:00.000Z");
  const previousA2 = work("a-old-2", "runtime-a", "review", "2026-09-27T10:01:00.000Z");
  const history = [dispatch("dispatch-1", [previousA1, previousA2], "2026-09-27T11:45:00.000Z")];
  const { catalog } = fixture([a, b], { "a-next": 10, "b-next": 10 }, history);

  const result = await catalog.evaluate({
    fairnessId: "fair-2",
    sourceEvaluationId: "queue-1",
    policy: { policyId: "fairness", version: 1, historyDispatches: 10, runtimeHistoryPenalty: 5 },
  });

  assert.deepEqual(result.orderedWorkIds, ["b-next", "a-next"]);
  assert.equal(result.decisions.find((item) => item.workId === "a-next").recentRuntimeSelections, 2);
  assert.equal(result.decisions.find((item) => item.workId === "a-next").runtimePenalty, 10);
  assert.deepEqual(result.historyDispatchIds, ["dispatch-1"]);
});

test("soft consecutive-runtime caps rotate work without making otherwise safe work ineligible", async () => {
  const a1 = work("a-1", "runtime-a", "review", "2026-09-27T09:00:00.000Z");
  const a2 = work("a-2", "runtime-a", "review", "2026-09-27T09:01:00.000Z");
  const b1 = work("b-1", "runtime-b", "review", "2026-09-27T09:02:00.000Z");
  const { catalog } = fixture([a1, a2, b1], { "a-1": 10, "a-2": 9, "b-1": 1 });

  const result = await catalog.evaluate({
    fairnessId: "fair-3",
    sourceEvaluationId: "queue-1",
    policy: { policyId: "fairness", version: 1, maxConsecutivePerRuntime: 1 },
  });

  assert.deepEqual(result.orderedWorkIds, ["a-1", "b-1", "a-2"]);
  assert.equal(result.total, 3);
});

test("a stale M37 work revision is rejected before fairness evidence is persisted", async () => {
  const item = work("stale", "runtime-a", "review", "2026-09-27T09:00:00.000Z");
  const { catalog, evaluations, byId } = fixture([item], { stale: 1 });
  byId.set("stale", { ...item, revision: 2 });

  await assert.rejects(
    () => catalog.evaluate({
      fairnessId: "fair-stale",
      sourceEvaluationId: "queue-1",
      policy: { policyId: "fairness", version: 1 },
    }),
    /changed from evaluated revision/i,
  );
  assert.equal(await evaluations.get("fair-stale"), null);
});

test("fairness evaluations are create-only and detached", async () => {
  const item = work("one", "runtime-a", "review", "2026-09-27T09:00:00.000Z");
  const { catalog } = fixture([item], { one: 1 });
  const first = await catalog.evaluate({
    fairnessId: "fair-immutable",
    sourceEvaluationId: "queue-1",
    policy: { policyId: "fairness", version: 1 },
  });
  first.orderedWorkIds[0] = "mutated";
  assert.equal((await catalog.get("fair-immutable")).orderedWorkIds[0], "one");
  await assert.rejects(
    () => catalog.evaluate({
      fairnessId: "fair-immutable",
      sourceEvaluationId: "queue-1",
      policy: { policyId: "fairness", version: 1 },
    }),
    /already exists/i,
  );
});

test("age-boost options require a positive boost interval", () => {
  assert.throws(
    () => validateRuntimeFleetConvergenceFairnessPolicy({
      policyId: "bad",
      version: 1,
      ageBoostPerStep: 2,
    }),
    /ageBoostStepMs is required/i,
  );
  assert.throws(
    () => validateRuntimeFleetConvergenceFairnessPolicy({
      policyId: "bad",
      version: 1,
      ageBoostStepMs: 0,
    }),
    /positive integer/i,
  );
});
