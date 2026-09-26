import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryRuntimeDeploymentStore,
  RuntimeDeploymentCatalog,
  RuntimeDeploymentExecutorRegistry,
  RuntimeDeploymentRunner,
} from "../dist/index.js";

function makePlan({ manualReview = false, stepCount = 2 } = {}) {
  const steps = Array.from({ length: stepCount }, (_, index) => ({
    id: `${String(index + 1).padStart(3, "0")}:upgrade-module:module-${index + 1}`,
    kind: "upgrade-module",
    moduleId: `module-${index + 1}`,
    fromVersion: 1,
    toVersion: 2,
    blocking: manualReview && index === 0,
    requiresManualReview: manualReview && index === 0,
    description: `Upgrade module ${index + 1}`,
  }));
  return {
    format: "nublox-metaobject-runtime-profile-upgrade",
    formatVersion: 1,
    profileId: "production",
    fromProfileVersion: 1,
    toProfileVersion: 2,
    impact: manualReview ? "breaking" : "compatible",
    requiresManualReview: manualReview,
    blockingStepCount: manualReview ? 1 : 0,
    moduleChanges: [],
    objectChanges: [],
    steps,
  };
}

function setup(plan = makePlan()) {
  const store = new MemoryRuntimeDeploymentStore();
  let clockTick = 0;
  const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, clockTick++));
  const planner = {
    async plan(profileId, fromProfileVersion, toProfileVersion) {
      return { ...structuredClone(plan), profileId, fromProfileVersion, toProfileVersion };
    },
  };
  const deployments = new RuntimeDeploymentCatalog(store, planner, clock);
  return { store, deployments, clock };
}

function keyedExecutor(calls, result = { status: "completed" }) {
  return {
    id: "test.keyed",
    kinds: ["upgrade-module"],
    idempotency: "keyed",
    async execute(context) {
      calls.push({
        stepId: context.step.id,
        key: context.idempotencyKey,
        attempt: context.attempt,
      });
      return typeof result === "function" ? result(context) : result;
    },
  };
}

test("executor registry rejects ambiguous or unsafe registrations", () => {
  const registry = new RuntimeDeploymentExecutorRegistry();
  assert.throws(
    () => registry.register({
      id: "unsafe",
      kinds: ["upgrade-module"],
      idempotency: "reconciled",
      execute: async () => ({ status: "completed" }),
    }),
    /must implement reconcile/i,
  );

  registry.register({
    id: "first",
    kinds: ["upgrade-module"],
    idempotency: "keyed",
    execute: async () => ({ status: "completed" }),
  });
  assert.throws(
    () => registry.register({
      id: "second",
      kinds: ["upgrade-module"],
      idempotency: "keyed",
      execute: async () => ({ status: "completed" }),
    }),
    /already handled by executor 'first'/,
  );
});

test("runner executes a deployment sequentially with stable keys and persisted evidence", async () => {
  const { deployments, clock } = setup();
  const calls = [];
  const registry = new RuntimeDeploymentExecutorRegistry().register(keyedExecutor(calls, (context) => ({
    status: "completed",
    evidence: {
      externalReference: `change:${context.step.moduleId}`,
      details: { attempt: context.attempt },
    },
  })));
  const runner = new RuntimeDeploymentRunner(deployments, registry, clock);

  await deployments.create("automatic", "production", 1, 2);
  const result = await runner.run("automatic");

  assert.equal(result.record.status, "completed");
  assert.equal(result.executedSteps, 2);
  assert.deepEqual(calls.map((call) => call.attempt), [1, 1]);
  assert.equal(calls[0].key, `automatic:${result.record.plan.steps[0].id}`);
  assert.equal(calls[1].key, `automatic:${result.record.plan.steps[1].id}`);
  assert.equal(result.record.steps[0].executorId, "test.keyed");
  assert.equal(result.record.steps[0].idempotencyKey, calls[0].key);
  assert.equal(result.record.steps[0].evidence.externalReference, "change:module-1");
  assert.equal(result.record.steps[0].evidence.details.attempt, 1);
});

test("missing executor and missing approval block before external execution", async () => {
  const { deployments, clock } = setup(makePlan({ manualReview: true, stepCount: 1 }));
  const runner = new RuntimeDeploymentRunner(deployments, new RuntimeDeploymentExecutorRegistry(), clock);
  const created = await deployments.create("blocked", "production", 1, 2);

  let result = await runner.run(created.deploymentId);
  assert.equal(result.blockedReason, "approval-required");
  assert.equal(result.record.status, "planned");
  assert.equal(result.record.steps[0].attempts, 0);

  const approved = await deployments.approve(created.deploymentId, result.record.revision);
  result = await runner.run(approved.deploymentId);
  assert.equal(result.blockedReason, "missing-executor");
  assert.equal(result.record.status, "running");
  assert.equal(result.record.steps[0].status, "pending");
  assert.equal(result.record.steps[0].attempts, 0);
});

test("executor failures are persisted and stop automatic progression", async () => {
  const { deployments, clock } = setup(makePlan({ stepCount: 1 }));
  const calls = [];
  const registry = new RuntimeDeploymentExecutorRegistry().register(keyedExecutor(calls, {
    status: "failed",
    error: "database unavailable",
    evidence: { details: { retryable: true } },
  }));
  const runner = new RuntimeDeploymentRunner(deployments, registry, clock);
  await deployments.create("failure", "production", 1, 2);

  const result = await runner.run("failure");
  assert.equal(result.record.status, "failed");
  assert.equal(result.blockedReason, "step-failed");
  assert.equal(result.executedSteps, 1);
  assert.equal(result.record.steps[0].lastError, "database unavailable");
  assert.deepEqual(result.record.steps[0].evidence.details, { retryable: true });
});

test("thrown executor errors become durable step failures", async () => {
  const { deployments, clock } = setup(makePlan({ stepCount: 1 }));
  const registry = new RuntimeDeploymentExecutorRegistry().register({
    id: "thrower",
    kinds: ["upgrade-module"],
    idempotency: "keyed",
    async execute() {
      throw new Error("network lost");
    },
  });
  const runner = new RuntimeDeploymentRunner(deployments, registry, clock);
  await deployments.create("thrown", "production", 1, 2);

  const result = await runner.run("thrown");
  assert.equal(result.record.status, "failed");
  assert.equal(result.record.steps[0].lastError, "network lost");
  assert.equal(result.record.steps[0].executorId, "thrower");
});

test("keyed resume safely retries with the identical idempotency key", async () => {
  const { deployments, clock } = setup(makePlan({ stepCount: 1 }));
  const calls = [];
  let fail = true;
  const registry = new RuntimeDeploymentExecutorRegistry().register(keyedExecutor(calls, () => {
    if (fail) return { status: "failed", error: "temporary" };
    return { status: "completed" };
  }));
  const runner = new RuntimeDeploymentRunner(deployments, registry, clock);
  await deployments.create("keyed-retry", "production", 1, 2);

  const failed = await runner.run("keyed-retry");
  assert.equal(failed.record.status, "failed");
  const firstKey = failed.record.steps[0].idempotencyKey;
  fail = false;

  const resumed = await runner.resume("keyed-retry");
  assert.equal(resumed.record.status, "completed");
  assert.equal(resumed.record.steps[0].attempts, 2);
  assert.equal(resumed.record.steps[0].idempotencyKey, firstKey);
  assert.deepEqual(calls.map((call) => call.key), [firstKey, firstKey]);
});

test("reconciled resume can confirm an uncertain side effect without executing twice", async () => {
  const { deployments, clock } = setup(makePlan({ stepCount: 1 }));
  let executions = 0;
  let reconciliations = 0;
  const registry = new RuntimeDeploymentExecutorRegistry().register({
    id: "reconciled-db",
    kinds: ["upgrade-module"],
    idempotency: "reconciled",
    async execute() {
      executions += 1;
      return { status: "completed" };
    },
    async reconcile(context) {
      reconciliations += 1;
      return {
        resolution: "completed",
        evidence: { externalReference: `migration:${context.idempotencyKey}` },
      };
    },
  });
  const runner = new RuntimeDeploymentRunner(deployments, registry, clock);

  let record = await deployments.create("uncertain", "production", 1, 2);
  record = await deployments.start(record.deploymentId, record.revision);
  const step = record.plan.steps[0];
  const key = `uncertain:${step.id}`;
  const lease = await deployments.beginNextStep(record.deploymentId, record.revision, {
    executorId: "reconciled-db",
    idempotencyKey: key,
  });
  assert.equal(lease.record.steps[0].status, "running");

  const resumed = await runner.resume(record.deploymentId);
  assert.equal(resumed.record.status, "completed");
  assert.equal(executions, 0);
  assert.equal(reconciliations, 1);
  assert.equal(resumed.record.steps[0].evidence.externalReference, `migration:${key}`);
});

test("unknown reconciliation remains blocked and executor mismatch is never replayed", async () => {
  const { deployments, clock } = setup(makePlan({ stepCount: 1 }));
  let record = await deployments.create("unknown", "production", 1, 2);
  record = await deployments.start(record.deploymentId, record.revision);
  const step = record.plan.steps[0];
  const lease = await deployments.beginNextStep(record.deploymentId, record.revision, {
    executorId: "old-executor",
    idempotencyKey: `unknown:${step.id}`,
  });

  const mismatchRegistry = new RuntimeDeploymentExecutorRegistry().register({
    id: "new-executor",
    kinds: ["upgrade-module"],
    idempotency: "keyed",
    execute: async () => ({ status: "completed" }),
  });
  let result = await new RuntimeDeploymentRunner(deployments, mismatchRegistry, clock).resume(record.deploymentId);
  assert.equal(result.blockedReason, "executor-mismatch");
  assert.equal(result.record.revision, lease.record.revision);

  const unknownRegistry = new RuntimeDeploymentExecutorRegistry().register({
    id: "old-executor",
    kinds: ["upgrade-module"],
    idempotency: "reconciled",
    execute: async () => ({ status: "completed" }),
    reconcile: async () => ({ resolution: "unknown" }),
  });
  result = await new RuntimeDeploymentRunner(deployments, unknownRegistry, clock).resume(record.deploymentId);
  assert.equal(result.blockedReason, "reconciliation-unknown");
  assert.equal(result.record.steps[0].status, "running");
});
