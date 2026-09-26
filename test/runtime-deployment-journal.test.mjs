import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryRuntimeDeploymentStore,
  RuntimeDeploymentCatalog,
  validateRuntimeDeploymentJournal,
} from "../dist/index.js";

function makePlan({ manualReview = false, stepCount = 1 } = {}) {
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
  let tick = 0;
  const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));
  const planner = {
    async plan(profileId, fromProfileVersion, toProfileVersion) {
      return { ...structuredClone(plan), profileId, fromProfileVersion, toProfileVersion };
    },
  };
  return { store, deployments: new RuntimeDeploymentCatalog(store, planner, clock) };
}

function kinds(record) {
  return record.journal.map((entry) => entry.kind);
}

test("successful deployment records a strictly ordered lifecycle journal", async () => {
  const { deployments } = setup();
  let record = await deployments.create("journal-success", "production", 1, 2);
  assert.deepEqual(kinds(record), ["deployment-created"]);

  record = await deployments.start(record.deploymentId, record.revision);
  const stepId = record.plan.steps[0].id;
  const lease = await deployments.beginNextStep(record.deploymentId, record.revision, {
    executorId: "mysql",
    idempotencyKey: `journal-success:${stepId}`,
  });
  record = await deployments.completeStep(
    record.deploymentId,
    stepId,
    lease.record.revision,
    { recordedAt: "2026-01-01T00:10:00.000Z", externalReference: "ddl:42", details: { rows: 7 } },
  );

  assert.equal(record.status, "completed");
  assert.deepEqual(kinds(record), [
    "deployment-created",
    "deployment-started",
    "step-leased",
    "step-completed",
    "deployment-completed",
  ]);
  assert.deepEqual(record.journal.map((entry) => entry.sequence), [1, 2, 3, 4, 5]);
  assert.equal(record.journal[2].executorId, "mysql");
  assert.equal(record.journal[2].idempotencyKey, `journal-success:${stepId}`);
  assert.equal(record.journal[3].evidence.externalReference, "ddl:42");
  validateRuntimeDeploymentJournal(record);
});

test("failure, retry and second attempt retain the complete history", async () => {
  const { deployments } = setup();
  let record = await deployments.create("journal-retry", "production", 1, 2);
  record = await deployments.start(record.deploymentId, record.revision);
  const stepId = record.plan.steps[0].id;
  let lease = await deployments.beginNextStep(record.deploymentId, record.revision, {
    executorId: "api",
    idempotencyKey: `journal-retry:${stepId}`,
  });
  record = await deployments.failStep(
    record.deploymentId,
    stepId,
    lease.record.revision,
    "service unavailable",
    { recordedAt: "2026-01-01T00:10:00.000Z", details: { status: 503 } },
  );
  record = await deployments.recoverStep(record.deploymentId, stepId, record.revision, "retry");
  lease = await deployments.beginNextStep(record.deploymentId, record.revision, {
    executorId: "api",
    idempotencyKey: `journal-retry:${stepId}`,
  });
  record = await deployments.completeStep(record.deploymentId, stepId, lease.record.revision);

  assert.deepEqual(kinds(record), [
    "deployment-created",
    "deployment-started",
    "step-leased",
    "step-failed",
    "step-retry-requested",
    "step-leased",
    "step-completed",
    "deployment-completed",
  ]);
  const leases = record.journal.filter((entry) => entry.kind === "step-leased");
  assert.deepEqual(leases.map((entry) => entry.attempt), [1, 2]);
  assert.equal(record.journal.find((entry) => entry.kind === "step-failed").error, "service unavailable");
  assert.equal(record.journal.find((entry) => entry.kind === "step-retry-requested").recoveryResolution, "retry");
  assert.equal(leases[0].idempotencyKey, leases[1].idempotencyKey);
});

test("confirmed recovery and unknown reconciliation are journalled explicitly", async () => {
  const { deployments } = setup();
  let record = await deployments.create("journal-recovery", "production", 1, 2);
  record = await deployments.start(record.deploymentId, record.revision);
  const stepId = record.plan.steps[0].id;
  let lease = await deployments.beginNextStep(record.deploymentId, record.revision, {
    executorId: "external",
    idempotencyKey: `journal-recovery:${stepId}`,
  });

  record = await deployments.recordUnknownReconciliation(record.deploymentId, stepId, lease.record.revision);
  assert.equal(record.journal.at(-1).kind, "step-reconciliation-unknown");
  assert.equal(record.journal.at(-1).recoveryResolution, "unknown");

  record = await deployments.recoverStep(
    record.deploymentId,
    stepId,
    record.revision,
    "completed",
    { recordedAt: "2026-01-01T00:20:00.000Z", externalReference: "job:complete" },
  );
  assert.equal(record.status, "completed");
  assert.deepEqual(kinds(record).slice(-2), ["step-recovered-completed", "deployment-completed"]);
  assert.equal(record.journal.at(-2).recoveryResolution, "completed");
  assert.equal(record.journal.at(-2).evidence.externalReference, "job:complete");
});

test("approval, cancellation and no-op completion are journalled", async () => {
  const reviewedSetup = setup(makePlan({ manualReview: true }));
  let reviewed = await reviewedSetup.deployments.create("reviewed-journal", "production", 1, 2);
  reviewed = await reviewedSetup.deployments.approve(reviewed.deploymentId, reviewed.revision);
  assert.deepEqual(kinds(reviewed), ["deployment-created", "deployment-approved"]);

  const cancelSetup = setup();
  let cancelled = await cancelSetup.deployments.create("cancelled-journal", "production", 1, 2);
  cancelled = await cancelSetup.deployments.cancel(cancelled.deploymentId, cancelled.revision);
  assert.deepEqual(kinds(cancelled), ["deployment-created", "deployment-cancelled"]);

  const noopSetup = setup(makePlan({ stepCount: 0 }));
  let noop = await noopSetup.deployments.create("noop-journal", "production", 1, 2);
  noop = await noopSetup.deployments.start(noop.deploymentId, noop.revision);
  assert.deepEqual(kinds(noop), ["deployment-created", "deployment-started", "deployment-completed"]);
});

test("memory store rejects a tampered journal sequence", async () => {
  const { store, deployments } = setup();
  const record = await deployments.create("tampered-journal", "production", 1, 2);
  const tampered = structuredClone(record);
  tampered.journal[0].sequence = 99;

  await assert.rejects(
    () => store.save(tampered, record.revision),
    /journal sequence 99 is invalid/i,
  );
});

test("journal reads are detached from persisted audit history", async () => {
  const { deployments } = setup();
  const record = await deployments.create("detached-journal", "production", 1, 2);
  const firstRead = await deployments.journal(record.deploymentId);
  firstRead[0].kind = "deployment-cancelled";

  const secondRead = await deployments.journal(record.deploymentId);
  assert.equal(secondRead[0].kind, "deployment-created");
  assert.equal(secondRead[0].sequence, 1);
});
