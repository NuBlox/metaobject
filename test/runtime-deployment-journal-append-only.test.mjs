import assert from "node:assert/strict";
import test from "node:test";
import {
  appendRuntimeDeploymentJournal,
  MemoryRuntimeDeploymentStore,
  RuntimeDeploymentCatalog,
} from "../dist/index.js";

function makePlan({ stepCount = 1 } = {}) {
  const steps = Array.from({ length: stepCount }, (_, index) => ({
    id: `${String(index + 1).padStart(3, "0")}:upgrade-module:module-${index + 1}`,
    kind: "upgrade-module",
    moduleId: `module-${index + 1}`,
    fromVersion: 1,
    toVersion: 2,
    blocking: false,
    requiresManualReview: false,
    description: `Upgrade module ${index + 1}`,
  }));
  return {
    format: "nublox-metaobject-runtime-profile-upgrade",
    formatVersion: 1,
    profileId: "production",
    fromProfileVersion: 1,
    toProfileVersion: 2,
    impact: "compatible",
    requiresManualReview: false,
    blockingStepCount: 0,
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

test("persisted journals cannot be truncated or removed", async () => {
  const { store, deployments } = setup();
  let record = await deployments.create("append-only-truncate", "production", 1, 2);
  record = await deployments.start(record.deploymentId, record.revision);
  assert.equal(record.journal.length, 2);

  const truncated = structuredClone(record);
  truncated.journal = truncated.journal.slice(0, 1);
  await assert.rejects(
    () => store.save(truncated, record.revision),
    /journal cannot be truncated from 2 to 1 entries/i,
  );

  const removed = structuredClone(record);
  delete removed.journal;
  await assert.rejects(
    () => store.save(removed, record.revision),
    /journal cannot be removed once established/i,
  );
});

test("persisted journal entries cannot be rewritten even when the new journal remains structurally valid", async () => {
  const { store, deployments } = setup();
  let record = await deployments.create("append-only-rewrite", "production", 1, 2);
  record = await deployments.start(record.deploymentId, record.revision);

  const rewritten = structuredClone(record);
  rewritten.journal[0].kind = "deployment-approved";
  await assert.rejects(
    () => store.save(rewritten, record.revision),
    /journal entry 1 is immutable and cannot be rewritten/i,
  );

  const timestampRewrite = structuredClone(record);
  timestampRewrite.journal[1].occurredAt = "2099-01-01T00:00:00.000Z";
  await assert.rejects(
    () => store.save(timestampRewrite, record.revision),
    /journal entry 2 is immutable and cannot be rewritten/i,
  );
});

test("nested evidence in an existing journal entry is immutable", async () => {
  const { store, deployments } = setup();
  let record = await deployments.create("append-only-evidence", "production", 1, 2);
  record = await deployments.start(record.deploymentId, record.revision);
  const stepId = record.plan.steps[0].id;
  const lease = await deployments.beginNextStep(record.deploymentId, record.revision, {
    executorId: "mysql",
    idempotencyKey: `append-only-evidence:${stepId}`,
  });
  record = await deployments.completeStep(
    record.deploymentId,
    stepId,
    lease.record.revision,
    {
      recordedAt: "2026-01-01T00:10:00.000Z",
      externalReference: "migration:42",
      details: {
        rows: 17,
        verification: { checksum: "abc", bytes: new Uint8Array([1, 2, 3]) },
      },
    },
  );

  const completedIndex = record.journal.findIndex((entry) => entry.kind === "step-completed");
  const tampered = structuredClone(record);
  tampered.journal[completedIndex].evidence.details.verification.checksum = "altered";

  await assert.rejects(
    () => store.save(tampered, record.revision),
    new RegExp(`journal entry ${completedIndex + 1} is immutable`, "i"),
  );
});

test("normal catalogue transitions append without rewriting prior history", async () => {
  const { deployments } = setup();
  let record = await deployments.create("append-only-normal", "production", 1, 2);
  const created = structuredClone(record.journal[0]);

  record = await deployments.start(record.deploymentId, record.revision);
  const stepId = record.plan.steps[0].id;
  const lease = await deployments.beginNextStep(record.deploymentId, record.revision, {
    executorId: "worker",
    idempotencyKey: `append-only-normal:${stepId}`,
  });
  record = await deployments.completeStep(record.deploymentId, stepId, lease.record.revision);

  assert.equal(record.status, "completed");
  assert.deepEqual(record.journal[0], created);
  assert.deepEqual(record.journal.map((entry) => entry.sequence), [1, 2, 3, 4, 5]);
});

test("legacy records without a journal may establish one on a later save", async () => {
  const store = new MemoryRuntimeDeploymentStore();
  const plan = makePlan({ stepCount: 0 });
  const legacy = await store.save({
    deploymentId: "legacy-no-journal",
    status: "planned",
    revision: 0,
    profileId: "production",
    fromProfileVersion: 1,
    toProfileVersion: 2,
    plan,
    steps: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(legacy.journal, undefined);

  const journal = appendRuntimeDeploymentJournal(legacy, {
    kind: "deployment-started",
    occurredAt: "2026-01-01T00:01:00.000Z",
  });
  const upgraded = await store.save({
    ...legacy,
    status: "running",
    journal,
    startedAt: "2026-01-01T00:01:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
  }, legacy.revision);

  assert.equal(upgraded.journal.length, 1);
  assert.equal(upgraded.journal[0].sequence, 1);
  assert.equal(upgraded.journal[0].kind, "deployment-started");
});

test("append-only checking happens after optimistic revision validation", async () => {
  const { store, deployments } = setup();
  const record = await deployments.create("append-only-concurrency", "production", 1, 2);
  const stale = structuredClone(record);
  stale.journal[0].kind = "deployment-cancelled";

  const advanced = await deployments.start(record.deploymentId, record.revision);
  assert.ok(advanced.revision > record.revision);
  await assert.rejects(
    () => store.save(stale, record.revision),
    /concurrency conflict/i,
  );
});
