import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryRuntimeFleetConvergenceQueueEvaluationStore,
  MemoryRuntimeFleetConvergenceWorkStore,
  MemoryRuntimeFleetPolicyDispatchStore,
  RuntimeFleetPolicyDispatcher,
} from "../dist/index.js";

function work(workId, runtimeId, action, createdAt) {
  return {
    format: "nublox-metaobject-runtime-fleet-convergence-work",
    formatVersion: 1,
    workId,
    revision: 0,
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

function queueEvaluation() {
  return {
    format: "nublox-metaobject-runtime-fleet-convergence-queue-evaluation",
    formatVersion: 1,
    evaluationId: "queue-1",
    policyId: "fleet-default",
    policyVersion: 7,
    decisions: [
      {
        workId: "work-a",
        runtimeId: "runtime-a",
        action: "reassess",
        workRevision: 1,
        priority: 100,
        status: "eligible",
        blockReasons: [],
        details: [],
      },
      {
        workId: "work-b",
        runtimeId: "runtime-b",
        action: "plan-remediation",
        workRevision: 1,
        priority: 50,
        status: "eligible",
        blockReasons: [],
        details: [],
      },
    ],
    eligibleWorkIds: ["work-a", "work-b"],
    total: 2,
    eligible: 2,
    blocked: 0,
    evaluatedAt: "2026-09-27T10:30:00.000Z",
  };
}

function completedDispatch(dispatchId, workerId, workIds) {
  const items = workIds.map((workId, index) => ({
    workId,
    runtimeId: index === 0 ? "runtime-a" : "runtime-b",
    action: index === 0 ? "reassess" : "plan-remediation",
    workRevisionBefore: 1,
    status: "completed",
    finalWorkStatus: "completed",
  }));
  return {
    format: "nublox-metaobject-runtime-fleet-convergence-dispatch",
    formatVersion: 1,
    dispatchId,
    workerId,
    outcome: "completed",
    items,
    total: items.length,
    completed: items.length,
    blocked: 0,
    failed: 0,
    startedAt: "2026-09-27T10:31:00.000Z",
    completedAt: "2026-09-27T10:31:01.000Z",
  };
}

class StubDispatcher {
  records = new Map();
  calls = [];

  async get(id) {
    return structuredClone(this.records.get(id) ?? null);
  }

  async dispatch(request) {
    this.calls.push(structuredClone(request));
    const run = completedDispatch(request.dispatchId, request.workerId, request.workIds ?? []);
    this.records.set(run.dispatchId, structuredClone(run));
    return structuredClone(run);
  }
}

async function fixture() {
  const workStore = new MemoryRuntimeFleetConvergenceWorkStore();
  await workStore.createMany([
    work("work-a", "runtime-a", "reassess", "2026-09-27T10:00:00.000Z"),
    work("work-b", "runtime-b", "plan-remediation", "2026-09-27T10:01:00.000Z"),
  ]);
  const convergence = {
    get: (id) => workStore.get(id),
  };
  const evaluations = new MemoryRuntimeFleetConvergenceQueueEvaluationStore();
  await evaluations.create(queueEvaluation());
  const dispatcher = new StubDispatcher();
  const admissions = new MemoryRuntimeFleetPolicyDispatchStore();
  let tick = 0;
  const catalog = new RuntimeFleetPolicyDispatcher(
    evaluations,
    convergence,
    dispatcher,
    admissions,
    () => new Date(`2026-09-27T10:32:0${tick++}.000Z`),
  );
  return { workStore, evaluations, dispatcher, admissions, catalog };
}

test("binds exact M37 eligibility to M36 dispatch and stores terminal linkage", async () => {
  const { catalog, dispatcher } = await fixture();
  const result = await catalog.dispatch({
    admissionId: "admit-1",
    evaluationId: "queue-1",
    dispatchId: "dispatch-1",
    workerId: "fleet-worker",
  });

  assert.equal(result.admission.status, "completed");
  assert.equal(result.admission.policyId, "fleet-default");
  assert.equal(result.admission.policyVersion, 7);
  assert.equal(result.admission.dispatchOutcome, "completed");
  assert.deepEqual(result.admission.work.map((item) => [item.workId, item.evaluatedRevision]), [
    ["work-a", 1],
    ["work-b", 1],
  ]);
  assert.deepEqual(dispatcher.calls[0].workIds, ["work-a", "work-b"]);
});

test("maxItems preserves M37 policy ordering in admitted dispatch", async () => {
  const { catalog, dispatcher } = await fixture();
  const result = await catalog.dispatch({
    admissionId: "admit-limited",
    evaluationId: "queue-1",
    dispatchId: "dispatch-limited",
    workerId: "fleet-worker",
    maxItems: 1,
  });
  assert.deepEqual(result.admission.work.map((item) => item.workId), ["work-a"]);
  assert.deepEqual(dispatcher.calls[0].workIds, ["work-a"]);
});

test("stale work revision rejects admission before any M36 side effect", async () => {
  const { catalog, workStore, dispatcher, admissions } = await fixture();
  const current = await workStore.get("work-a");
  await workStore.save({ ...current, updatedAt: "2026-09-27T10:29:00.000Z" }, current.revision);

  await assert.rejects(
    () => catalog.dispatch({
      admissionId: "admit-stale",
      evaluationId: "queue-1",
      dispatchId: "dispatch-stale",
      workerId: "fleet-worker",
    }),
    /is stale/i,
  );
  assert.equal(dispatcher.calls.length, 0);
  assert.equal(await admissions.get("admit-stale"), null);
});

test("resume reconciles a dispatch created before the admission could be finalized", async () => {
  const { dispatcher, admissions, catalog } = await fixture();
  const admitted = await admissions.create({
    format: "nublox-metaobject-runtime-fleet-policy-dispatch",
    formatVersion: 1,
    admissionId: "admit-existing-dispatch",
    revision: 0,
    status: "admitted",
    evaluationId: "queue-1",
    policyId: "fleet-default",
    policyVersion: 7,
    dispatchId: "dispatch-existing",
    workerId: "fleet-worker",
    work: [
      { workId: "work-a", runtimeId: "runtime-a", action: "reassess", evaluatedRevision: 1 },
    ],
    admittedAt: "2026-09-27T10:31:00.000Z",
  });
  dispatcher.records.set("dispatch-existing", completedDispatch("dispatch-existing", "fleet-worker", ["work-a"]));

  const result = await catalog.resume(admitted.admissionId);
  assert.equal(result.admission.status, "completed");
  assert.equal(dispatcher.calls.length, 0);
  assert.equal(result.dispatch.dispatchId, "dispatch-existing");
});

test("resume starts the exact admitted M36 dispatch when no dispatch record exists", async () => {
  const { dispatcher, admissions, catalog } = await fixture();
  await admissions.create({
    format: "nublox-metaobject-runtime-fleet-policy-dispatch",
    formatVersion: 1,
    admissionId: "admit-resume",
    revision: 0,
    status: "admitted",
    evaluationId: "queue-1",
    policyId: "fleet-default",
    policyVersion: 7,
    dispatchId: "dispatch-resume",
    workerId: "fleet-worker",
    work: [
      { workId: "work-a", runtimeId: "runtime-a", action: "reassess", evaluatedRevision: 1 },
    ],
    admittedAt: "2026-09-27T10:31:00.000Z",
  });

  const result = await catalog.resume("admit-resume");
  assert.equal(result.admission.status, "completed");
  assert.equal(dispatcher.calls.length, 1);
  assert.deepEqual(dispatcher.calls[0].workIds, ["work-a"]);
});

test("policy-dispatch provenance is immutable and terminal records cannot be rewritten", async () => {
  const { catalog, admissions } = await fixture();
  const result = await catalog.dispatch({
    admissionId: "admit-immutable",
    evaluationId: "queue-1",
    dispatchId: "dispatch-immutable",
    workerId: "fleet-worker",
  });
  const stored = await admissions.get("admit-immutable");
  stored.work[0].workId = "mutated";
  assert.equal((await admissions.get("admit-immutable")).work[0].workId, "work-a");
  await assert.rejects(
    () => admissions.save(result.admission, result.admission.revision),
    /terminal.*immutable/i,
  );
});
