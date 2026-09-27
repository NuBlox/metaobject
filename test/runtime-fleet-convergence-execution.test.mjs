import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryRuntimeFleetConvergenceExecutionStore,
  MemoryRuntimeFleetConvergenceWorkStore,
  MemoryRuntimeFleetReconciliationStore,
  MemoryRuntimeTargetStore,
  RuntimeFleetConvergenceCatalog,
  RuntimeFleetConvergenceExecutorRegistry,
  RuntimeFleetConvergenceRunner,
} from "../dist/index.js";

function target(runtimeId = "runtime-a") {
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

async function fixture() {
  const targets = new MemoryRuntimeTargetStore();
  await targets.save(target(), 0);

  const reconciliations = new MemoryRuntimeFleetReconciliationStore();
  await reconciliations.create({
    format: "nublox-metaobject-runtime-fleet-reconciliation",
    formatVersion: 1,
    runId: "reconcile-1",
    outcome: "action-required",
    targets: [{
      runtimeId: "runtime-a",
      targetRevision: 1,
      targetStatus: "active",
      desiredProfile: { profileId: "production", profileVersion: 2 },
      observedProfile: { profileId: "production", profileVersion: 1 },
      postureState: "verified",
      compliance: "profile-behind",
      recommendedAction: "plan-profile-upgrade",
      reason: "profile behind",
    }],
    total: 1,
    compliant: 0,
    actionRequired: 1,
    reviewRequired: 0,
    retired: 0,
    capturedAt: "2026-09-27T10:00:00.000Z",
  });

  const workStore = new MemoryRuntimeFleetConvergenceWorkStore();
  let catalogTick = 0;
  const convergence = new RuntimeFleetConvergenceCatalog(
    workStore,
    reconciliations,
    targets,
    () => new Date(`2026-09-27T10:10:0${catalogTick++}.000Z`),
  );
  const [work] = await convergence.materialize("reconcile-1");

  const executions = new MemoryRuntimeFleetConvergenceExecutionStore();
  const executors = new RuntimeFleetConvergenceExecutorRegistry();
  let runnerTick = 0;
  const runner = new RuntimeFleetConvergenceRunner(
    convergence,
    targets,
    executions,
    executors,
    () => new Date(`2026-09-27T10:20:0${runnerTick++}.000Z`),
  );
  return { targets, convergence, executions, executors, runner, work };
}

test("executor registry rejects ambiguous and unsafe registrations", () => {
  const registry = new RuntimeFleetConvergenceExecutorRegistry();
  registry.register({
    id: "upgrade",
    actions: ["plan-profile-upgrade"],
    idempotency: "keyed",
    execute() { throw new Error("unused"); },
  });
  assert.throws(
    () => registry.register({
      id: "duplicate-action",
      actions: ["plan-profile-upgrade"],
      idempotency: "keyed",
      execute() { throw new Error("unused"); },
    }),
    /already handled/i,
  );
  assert.throws(
    () => new RuntimeFleetConvergenceExecutorRegistry().register({
      id: "unsafe",
      actions: ["plan-remediation"],
      idempotency: "reconciled",
      execute() { throw new Error("unused"); },
    }),
    /must implement reconcile/i,
  );
});

test("runner executes revision-bound work and persists evidence", async () => {
  const { executors, runner, executions, work } = await fixture();
  let seen;
  executors.register({
    id: "upgrade-planner",
    actions: ["plan-profile-upgrade"],
    idempotency: "keyed",
    execute(context) {
      seen = context;
      return {
        status: "completed",
        targetRevision: context.target.revision,
        summary: "upgrade plan prepared",
        evidence: { externalReference: "plan-123", details: { steps: 4 } },
      };
    },
  });

  const result = await runner.run(work.workId, "worker-a");
  assert.equal(result.work.status, "completed");
  assert.equal(result.execution.status, "completed");
  assert.equal(result.execution.executorId, "upgrade-planner");
  assert.equal(result.execution.evidence.externalReference, "plan-123");
  assert.equal(seen.idempotencyKey, `${work.workId}:${work.action}`);
  assert.equal(seen.attempt, 1);
  assert.equal((await executions.list(work.workId)).length, 1);
});

test("missing executor and stale target block before external execution", async () => {
  const missing = await fixture();
  const missingResult = await missing.runner.run(missing.work.workId, "worker-a");
  assert.equal(missingResult.blockedReason, "missing-executor");
  assert.equal(missingResult.work.status, "pending");

  const stale = await fixture();
  let executed = false;
  stale.executors.register({
    id: "upgrade-planner",
    actions: ["plan-profile-upgrade"],
    idempotency: "keyed",
    execute() { executed = true; throw new Error("should not execute"); },
  });
  const current = await stale.targets.get("runtime-a");
  await stale.targets.save({ ...current, updatedAt: "2026-09-27T10:30:00.000Z" }, current.revision);
  const staleResult = await stale.runner.run(stale.work.workId, "worker-a");
  assert.equal(staleResult.blockedReason, "stale-target");
  assert.equal(staleResult.work.status, "pending");
  assert.equal(executed, false);
});

test("thrown executor failures fail closed and retain uncertain evidence state", async () => {
  const { executors, runner, executions, work } = await fixture();
  executors.register({
    id: "upgrade-planner",
    actions: ["plan-profile-upgrade"],
    idempotency: "keyed",
    execute() { throw new Error("planner transport dropped"); },
  });

  const result = await runner.run(work.workId, "worker-a");
  assert.equal(result.blockedReason, "work-failed");
  assert.equal(result.work.status, "failed");
  assert.equal(result.execution.status, "failed");
  assert.equal(result.execution.uncertain, true);
  assert.equal(result.execution.targetRevisionAfter, undefined);
  assert.match(result.execution.error, /transport dropped/i);
  assert.equal((await executions.list(work.workId))[0].uncertain, true);
});

test("retry uses a new attempt with the same stable idempotency key", async () => {
  const { executors, runner, executions, work } = await fixture();
  let calls = 0;
  executors.register({
    id: "upgrade-planner",
    actions: ["plan-profile-upgrade"],
    idempotency: "keyed",
    execute(context) {
      calls += 1;
      if (calls === 1) {
        return { status: "failed", targetRevision: context.target.revision, error: "temporary planner failure" };
      }
      return { status: "completed", targetRevision: context.target.revision, summary: "upgrade plan prepared" };
    },
  });

  const first = await runner.run(work.workId, "worker-a");
  assert.equal(first.work.status, "failed");
  const second = await runner.retry(work.workId, "worker-b");
  assert.equal(second.work.status, "completed");

  const history = await executions.list(work.workId);
  assert.equal(history.length, 2);
  assert.deepEqual(history.map((item) => item.attempt), [1, 2]);
  assert.equal(history[0].idempotencyKey, history[1].idempotencyKey);
  assert.equal(history[0].uncertain, false);
});

test("resume replays a keyed running attempt with its original idempotency key", async () => {
  const { targets, convergence, executions, executors, runner, work } = await fixture();
  const claimed = await convergence.claim(work.workId, "worker-a", work.revision);
  const targetRecord = await targets.get("runtime-a");
  const execution = await executions.create({
    format: "nublox-metaobject-runtime-fleet-convergence-execution",
    formatVersion: 1,
    executionId: `${work.workId}:attempt:1`,
    revision: 0,
    workId: work.workId,
    runtimeId: "runtime-a",
    action: work.action,
    attempt: 1,
    executorId: "upgrade-planner",
    idempotencyKey: "stable-key",
    desiredProfile: targetRecord.desiredProfile,
    targetRevisionBefore: targetRecord.revision,
    status: "running",
    startedAt: "2026-09-27T10:20:00.000Z",
  });
  let seenKey;
  executors.register({
    id: "upgrade-planner",
    actions: ["plan-profile-upgrade"],
    idempotency: "keyed",
    execute(context) {
      seenKey = context.idempotencyKey;
      return { status: "completed", targetRevision: context.target.revision, summary: "recovered plan" };
    },
  });

  assert.equal(claimed.status, "in-progress");
  assert.equal(execution.status, "running");
  const resumed = await runner.resume(work.workId);
  assert.equal(resumed.work.status, "completed");
  assert.equal(resumed.execution.status, "completed");
  assert.equal(seenKey, "stable-key");
});

test("reconciled recovery can confirm an interrupted side effect without executing twice", async () => {
  const { targets, convergence, executions, executors, runner, work } = await fixture();
  await convergence.claim(work.workId, "worker-a", work.revision);
  const targetRecord = await targets.get("runtime-a");
  await executions.create({
    format: "nublox-metaobject-runtime-fleet-convergence-execution",
    formatVersion: 1,
    executionId: `${work.workId}:attempt:1`,
    revision: 0,
    workId: work.workId,
    runtimeId: "runtime-a",
    action: work.action,
    attempt: 1,
    executorId: "reconciled-upgrade",
    idempotencyKey: "stable-key",
    desiredProfile: targetRecord.desiredProfile,
    targetRevisionBefore: targetRecord.revision,
    status: "running",
    startedAt: "2026-09-27T10:20:00.000Z",
  });
  let executes = 0;
  let reconciles = 0;
  executors.register({
    id: "reconciled-upgrade",
    actions: ["plan-profile-upgrade"],
    idempotency: "reconciled",
    execute(context) {
      executes += 1;
      return { status: "completed", targetRevision: context.target.revision, summary: "should not run" };
    },
    reconcile(context) {
      reconciles += 1;
      return {
        resolution: "completed",
        targetRevision: context.target.revision,
        summary: "existing plan confirmed",
        evidence: { externalReference: "plan-existing" },
      };
    },
  });

  const resumed = await runner.resume(work.workId);
  assert.equal(resumed.work.status, "completed");
  assert.equal(resumed.execution.evidence.externalReference, "plan-existing");
  assert.equal(executes, 0);
  assert.equal(reconciles, 1);
});

test("execution store returns detached records and terminal attempts are immutable", async () => {
  const { executors, runner, executions, work } = await fixture();
  executors.register({
    id: "upgrade-planner",
    actions: ["plan-profile-upgrade"],
    idempotency: "keyed",
    execute(context) {
      return { status: "completed", targetRevision: context.target.revision, summary: "done" };
    },
  });
  const result = await runner.run(work.workId, "worker-a");
  result.execution.evidence = { externalReference: "mutated" };
  const stored = (await executions.list(work.workId))[0];
  assert.equal(stored.evidence, undefined);
  await assert.rejects(
    () => executions.save({ ...stored, summary: "rewritten" }, stored.revision),
    /terminal.*immutable/i,
  );
});
