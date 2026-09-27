import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryRuntimeFleetConvergenceDispatchStore,
  MemoryRuntimeFleetConvergenceWorkStore,
  MemoryRuntimeFleetReconciliationStore,
  MemoryRuntimeTargetStore,
  RuntimeFleetConvergenceCatalog,
  RuntimeFleetConvergenceDispatcher,
} from "../dist/index.js";

function target(runtimeId) {
  return {
    format: "nublox-metaobject-runtime-target",
    formatVersion: 1,
    runtimeId,
    revision: 0,
    status: "active",
    desiredProfile: { profileId: "production", profileVersion: 2 },
    createdAt: "2026-09-27T09:00:00.000Z",
    updatedAt: "2026-09-27T09:00:00.000Z",
  };
}

function reconciliationTarget(runtimeId, action, compliance) {
  return {
    runtimeId,
    targetRevision: 1,
    targetStatus: "active",
    desiredProfile: { profileId: "production", profileVersion: 2 },
    compliance,
    recommendedAction: action,
    reason: `${runtimeId}-${action}`,
  };
}

async function fixture() {
  const targets = new MemoryRuntimeTargetStore();
  for (const runtimeId of ["runtime-a", "runtime-b", "runtime-c"]) {
    await targets.save(target(runtimeId), 0);
  }

  const reconciliations = new MemoryRuntimeFleetReconciliationStore();
  await reconciliations.create({
    format: "nublox-metaobject-runtime-fleet-reconciliation",
    formatVersion: 1,
    runId: "reconcile-1",
    outcome: "review-required",
    targets: [
      reconciliationTarget("runtime-a", "plan-profile-upgrade", "profile-behind"),
      reconciliationTarget("runtime-b", "plan-remediation", "drifted"),
      reconciliationTarget("runtime-c", "review", "review"),
    ],
    total: 3,
    compliant: 0,
    actionRequired: 2,
    reviewRequired: 1,
    retired: 0,
    capturedAt: "2026-09-27T10:00:00.000Z",
  });

  const workStore = new MemoryRuntimeFleetConvergenceWorkStore();
  let workTick = 0;
  const convergence = new RuntimeFleetConvergenceCatalog(
    workStore,
    reconciliations,
    targets,
    () => new Date(`2026-09-27T10:10:0${workTick++}.000Z`),
  );
  const work = await convergence.materialize("reconcile-1");
  const runs = new MemoryRuntimeFleetConvergenceDispatchStore();
  let dispatchTick = 0;
  return {
    targets,
    convergence,
    work,
    runs,
    clock: () => new Date(`2026-09-27T10:30:0${dispatchTick++}.000Z`),
  };
}

test("dispatch isolates completed, blocked and failed work into immutable fleet evidence", async () => {
  const { convergence, runs, clock } = await fixture();
  const runner = {
    async run(workId, workerId) {
      const current = await convergence.get(workId);
      if (current.runtimeId === "runtime-a") {
        const claimed = await convergence.claim(workId, workerId, current.revision);
        const completed = await convergence.complete(workId, "plan prepared", claimed.revision);
        return { work: completed, execution: { executionId: "exec-a" } };
      }
      if (current.runtimeId === "runtime-b") {
        return { work: current, blockedReason: "missing-executor" };
      }
      throw new Error("review provider unavailable");
    },
  };
  const dispatcher = new RuntimeFleetConvergenceDispatcher(convergence, runner, runs, clock);
  const run = await dispatcher.dispatch({ dispatchId: "dispatch-1", workerId: "fleet-worker" });

  assert.equal(run.outcome, "partial");
  assert.equal(run.total, 3);
  assert.equal(run.completed, 1);
  assert.equal(run.blocked, 1);
  assert.equal(run.failed, 1);
  assert.deepEqual(run.items.map((item) => item.runtimeId), ["runtime-a", "runtime-b", "runtime-c"]);
  assert.equal(run.items[0].status, "completed");
  assert.equal(run.items[0].executionId, "exec-a");
  assert.equal(run.items[1].blockedReason, "missing-executor");
  assert.match(run.items[2].error, /review provider unavailable/i);
});

test("dispatch supports action filters and bounded deterministic slices", async () => {
  const { convergence, runs, clock } = await fixture();
  const called = [];
  const runner = {
    async run(workId) {
      const current = await convergence.get(workId);
      called.push(current.runtimeId);
      return { work: current, blockedReason: "missing-executor" };
    },
  };
  const dispatcher = new RuntimeFleetConvergenceDispatcher(convergence, runner, runs, clock);

  const remediation = await dispatcher.dispatch({
    dispatchId: "dispatch-remediation",
    workerId: "worker",
    actions: ["plan-remediation"],
    maxItems: 10,
  });
  assert.deepEqual(called, ["runtime-b"]);
  assert.equal(remediation.total, 1);

  called.length = 0;
  const limited = await dispatcher.dispatch({
    dispatchId: "dispatch-limited",
    workerId: "worker",
    maxItems: 1,
  });
  assert.equal(limited.total, 1);
  assert.deepEqual(called, ["runtime-a"]);
});

test("explicit work selection rejects duplicate and unknown ids", async () => {
  const { convergence, work, runs, clock } = await fixture();
  const runner = { async run() { throw new Error("unused"); } };
  const dispatcher = new RuntimeFleetConvergenceDispatcher(convergence, runner, runs, clock);

  await assert.rejects(
    () => dispatcher.dispatch({
      dispatchId: "dispatch-duplicate",
      workerId: "worker",
      workIds: [work[0].workId, work[0].workId],
    }),
    /duplicate work/i,
  );
  await assert.rejects(
    () => dispatcher.dispatch({
      dispatchId: "dispatch-unknown",
      workerId: "worker",
      workIds: ["missing-work"],
    }),
    /unknown.*work/i,
  );
});

test("dispatch history is create-only, filterable and detached", async () => {
  const { convergence, runs, clock } = await fixture();
  const runner = {
    async run(workId) {
      const current = await convergence.get(workId);
      return { work: current, blockedReason: "missing-executor" };
    },
  };
  const dispatcher = new RuntimeFleetConvergenceDispatcher(convergence, runner, runs, clock);
  const run = await dispatcher.dispatch({ dispatchId: "dispatch-1", workerId: "worker-a", maxItems: 1 });
  run.items[0].status = "failed";

  const persisted = await dispatcher.get("dispatch-1");
  assert.equal(persisted.items[0].status, "blocked");
  assert.equal((await dispatcher.history({ workerId: "worker-a" })).length, 1);
  assert.equal((await dispatcher.history({ outcome: "partial" })).length, 1);
  await assert.rejects(
    () => dispatcher.dispatch({ dispatchId: "dispatch-1", workerId: "worker-a", maxItems: 1 }),
    /already exists/i,
  );
});

test("empty pending queue produces a valid completed no-op dispatch", async () => {
  const targets = new MemoryRuntimeTargetStore();
  const reconciliations = new MemoryRuntimeFleetReconciliationStore();
  const workStore = new MemoryRuntimeFleetConvergenceWorkStore();
  const convergence = new RuntimeFleetConvergenceCatalog(workStore, reconciliations, targets);
  const runs = new MemoryRuntimeFleetConvergenceDispatchStore();
  const runner = { async run() { throw new Error("unused"); } };
  const dispatcher = new RuntimeFleetConvergenceDispatcher(convergence, runner, runs);

  const run = await dispatcher.dispatch({ dispatchId: "empty", workerId: "worker" });
  assert.equal(run.outcome, "completed");
  assert.equal(run.total, 0);
  assert.deepEqual(run.items, []);
});
