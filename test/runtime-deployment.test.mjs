import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryRuntimeDeploymentStore,
  RuntimeDeploymentCatalog,
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
      return {
        ...structuredClone(plan),
        profileId,
        fromProfileVersion,
        toProfileVersion,
      };
    },
  };
  return {
    store,
    deployments: new RuntimeDeploymentCatalog(store, planner, clock),
  };
}

test("deployment creation freezes an exact plan and uses optimistic revisions", async () => {
  const original = makePlan();
  const { deployments } = setup(original);
  const created = await deployments.create("deploy-1", "production", 1, 2);
  assert.equal(created.status, "planned");
  assert.equal(created.revision, 1);
  assert.deepEqual(created.steps.map((step) => step.status), ["pending", "pending"]);

  original.steps[0].description = "mutated after creation";
  assert.equal((await deployments.get("deploy-1")).plan.steps[0].description, "Upgrade module 1");
  await assert.rejects(() => deployments.create("deploy-1", "production", 1, 2), /already exists/);

  const approved = await deployments.approve("deploy-1", created.revision);
  assert.equal(approved.revision, 2);
  await assert.rejects(() => deployments.start("deploy-1", created.revision), /concurrency conflict/i);
});

test("manual-review deployments require explicit approval before execution", async () => {
  const { deployments } = setup(makePlan({ manualReview: true }));
  let record = await deployments.create("reviewed", "production", 1, 2);
  await assert.rejects(() => deployments.start(record.deploymentId, record.revision), /requires explicit approval/);

  record = await deployments.approve(record.deploymentId, record.revision);
  assert.ok(record.approvedAt);
  record = await deployments.start(record.deploymentId, record.revision);
  assert.equal(record.status, "running");
  assert.ok(record.startedAt);
});

test("deployment steps are leased durably and complete sequentially", async () => {
  const { deployments } = setup();
  let record = await deployments.create("sequential", "production", 1, 2);
  record = await deployments.start(record.deploymentId, record.revision);

  let lease = await deployments.beginNextStep(record.deploymentId, record.revision);
  record = lease.record;
  assert.equal(lease.step.id, record.steps[0].stepId);
  assert.equal(record.steps[0].status, "running");
  assert.equal(record.steps[0].attempts, 1);
  await assert.rejects(
    () => deployments.beginNextStep(record.deploymentId, record.revision),
    /unresolved running step.*recover it explicitly/,
  );

  record = await deployments.completeStep(record.deploymentId, lease.step.id, record.revision);
  assert.equal(record.status, "running");
  assert.equal(record.steps[0].status, "completed");

  lease = await deployments.beginNextStep(record.deploymentId, record.revision);
  record = await deployments.completeStep(record.deploymentId, lease.step.id, lease.record.revision);
  assert.equal(record.status, "completed");
  assert.ok(record.completedAt);
  assert.deepEqual(record.steps.map((step) => step.status), ["completed", "completed"]);
});

test("failed steps can be explicitly retried without losing attempt history", async () => {
  const { deployments } = setup(makePlan({ stepCount: 1 }));
  let record = await deployments.create("retry", "production", 1, 2);
  record = await deployments.start(record.deploymentId, record.revision);
  let lease = await deployments.beginNextStep(record.deploymentId, record.revision);
  record = await deployments.failStep(record.deploymentId, lease.step.id, lease.record.revision, "database unavailable");
  assert.equal(record.status, "failed");
  assert.equal(record.steps[0].status, "failed");
  assert.equal(record.steps[0].attempts, 1);
  assert.equal(record.steps[0].lastError, "database unavailable");

  record = await deployments.recoverStep(record.deploymentId, lease.step.id, record.revision, "retry");
  assert.equal(record.status, "running");
  assert.equal(record.steps[0].status, "pending");
  assert.equal(record.steps[0].attempts, 1);

  lease = await deployments.beginNextStep(record.deploymentId, record.revision);
  assert.equal(lease.record.steps[0].attempts, 2);
  record = await deployments.completeStep(record.deploymentId, lease.step.id, lease.record.revision);
  assert.equal(record.status, "completed");
});

test("an interrupted in-flight step requires explicit recovery and can be confirmed completed", async () => {
  const { deployments } = setup(makePlan({ stepCount: 1 }));
  let record = await deployments.create("interrupted", "production", 1, 2);
  record = await deployments.start(record.deploymentId, record.revision);
  const lease = await deployments.beginNextStep(record.deploymentId, record.revision);

  // Simulate a restarted process reading the durable running step after an external side effect.
  const reloaded = await deployments.get(record.deploymentId);
  assert.equal(reloaded.steps[0].status, "running");
  await assert.rejects(
    () => deployments.beginNextStep(reloaded.deploymentId, reloaded.revision),
    /unresolved running step/,
  );

  record = await deployments.recoverStep(
    reloaded.deploymentId,
    lease.step.id,
    reloaded.revision,
    "completed",
  );
  assert.equal(record.status, "completed");
  assert.equal(record.steps[0].status, "completed");
});

test("cancellation is allowed only before execution starts", async () => {
  const { deployments } = setup();
  let record = await deployments.create("cancel", "production", 1, 2);
  const cancelled = await deployments.cancel(record.deploymentId, record.revision);
  assert.equal(cancelled.status, "cancelled");
  assert.ok(cancelled.cancelledAt);

  record = await deployments.create("started", "production", 1, 2);
  record = await deployments.start(record.deploymentId, record.revision);
  await assert.rejects(() => deployments.cancel(record.deploymentId, record.revision), /Only a planned/);
});

test("a deployment with no work completes atomically when started", async () => {
  const { deployments } = setup(makePlan({ stepCount: 0 }));
  let record = await deployments.create("noop", "production", 1, 2);
  record = await deployments.start(record.deploymentId, record.revision);
  assert.equal(record.status, "completed");
  assert.ok(record.startedAt);
  assert.ok(record.completedAt);
});
