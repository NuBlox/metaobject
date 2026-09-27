import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryRuntimeFleetConvergenceWorkStore,
  MemoryRuntimeFleetReconciliationStore,
  MemoryRuntimeTargetStore,
  RuntimeFleetConvergenceCatalog,
} from "../dist/index.js";

function target(runtimeId, profileVersion = 2) {
  return {
    format: "nublox-metaobject-runtime-target",
    formatVersion: 1,
    runtimeId,
    revision: 0,
    status: "active",
    desiredProfile: { profileId: "production", profileVersion },
    createdAt: "2026-09-27T09:00:00.000Z",
    updatedAt: "2026-09-27T09:00:00.000Z",
  };
}

function result(runtimeId, action, compliance, reason = action) {
  return {
    runtimeId,
    targetRevision: 1,
    targetStatus: "active",
    desiredProfile: { profileId: "production", profileVersion: 2 },
    compliance,
    recommendedAction: action,
    reason,
  };
}

async function fixture() {
  const targets = new MemoryRuntimeTargetStore();
  for (const runtimeId of ["compliant", "upgrade", "drift", "review", "cancel"]) {
    await targets.save(target(runtimeId), 0);
  }

  const reconciliations = new MemoryRuntimeFleetReconciliationStore();
  await reconciliations.create({
    format: "nublox-metaobject-runtime-fleet-reconciliation",
    formatVersion: 1,
    runId: "reconcile-1",
    outcome: "review-required",
    targets: [
      result("compliant", "none", "compliant"),
      result("upgrade", "plan-profile-upgrade", "profile-behind"),
      result("drift", "plan-remediation", "drifted"),
      result("review", "review", "review"),
      result("cancel", "reassess", "stale"),
    ],
    total: 5,
    compliant: 1,
    actionRequired: 3,
    reviewRequired: 1,
    retired: 0,
    capturedAt: "2026-09-27T10:00:00.000Z",
  });

  const work = new MemoryRuntimeFleetConvergenceWorkStore();
  let tick = 0;
  const catalog = new RuntimeFleetConvergenceCatalog(
    work,
    reconciliations,
    targets,
    () => new Date(`2026-09-27T10:10:0${tick++}.000Z`),
  );
  return { targets, reconciliations, work, catalog };
}

function byRuntime(items, runtimeId) {
  return items.find((item) => item.runtimeId === runtimeId);
}

test("materializes only actionable M33 results into durable pending work", async () => {
  const { catalog } = await fixture();
  const items = await catalog.materialize("reconcile-1");
  assert.equal(items.length, 4);
  assert.equal(byRuntime(items, "compliant"), undefined);
  assert.deepEqual(
    items.map((item) => [item.runtimeId, item.action, item.status, item.revision]),
    [
      ["upgrade", "plan-profile-upgrade", "pending", 1],
      ["drift", "plan-remediation", "pending", 1],
      ["review", "review", "pending", 1],
      ["cancel", "reassess", "pending", 1],
    ],
  );
  assert.match(items[0].workId, /^work:/);
});

test("claims revision-bound work and records successful completion", async () => {
  const { catalog } = await fixture();
  const items = await catalog.materialize("reconcile-1");
  const pending = byRuntime(items, "upgrade");
  const claimed = await catalog.claim(pending.workId, "worker-a", pending.revision);
  assert.equal(claimed.status, "in-progress");
  assert.equal(claimed.revision, 2);
  assert.equal(claimed.claimedBy, "worker-a");

  const completed = await catalog.complete(claimed.workId, "upgrade plan prepared", claimed.revision);
  assert.equal(completed.status, "completed");
  assert.equal(completed.revision, 3);
  assert.equal(completed.result, "upgrade plan prepared");
  assert.ok(completed.finishedAt);
});

test("a changed M31 target revision makes unclaimed convergence work stale", async () => {
  const { catalog, targets } = await fixture();
  const items = await catalog.materialize("reconcile-1");
  const pending = byRuntime(items, "drift");
  const current = await targets.get("drift");
  await targets.save({ ...current, updatedAt: "2026-09-27T10:11:00.000Z" }, current.revision);

  await assert.rejects(
    () => catalog.claim(pending.workId, "worker-a", pending.revision),
    /is stale/i,
  );
  assert.equal((await catalog.get(pending.workId)).status, "pending");
});

test("failed work can be retried with a new claim while preserving optimistic revisions", async () => {
  const { catalog } = await fixture();
  const pending = byRuntime(await catalog.materialize("reconcile-1"), "drift");
  const firstClaim = await catalog.claim(pending.workId, "worker-a", pending.revision);
  const failed = await catalog.fail(firstClaim.workId, "planner unavailable", firstClaim.revision);
  assert.equal(failed.status, "failed");
  assert.equal(failed.revision, 3);

  const retried = await catalog.retry(failed.workId, failed.revision);
  assert.equal(retried.status, "pending");
  assert.equal(retried.revision, 4);
  assert.equal(retried.claimedBy, undefined);
  assert.equal(retried.finishedAt, undefined);
  assert.equal(retried.result, undefined);

  const secondClaim = await catalog.claim(retried.workId, "worker-b", retried.revision);
  assert.equal(secondClaim.claimedBy, "worker-b");
  assert.equal(secondClaim.revision, 5);
});

test("pending work can be cancelled but claimed work cannot be cancelled", async () => {
  const { catalog } = await fixture();
  const items = await catalog.materialize("reconcile-1");
  const cancel = byRuntime(items, "cancel");
  const cancelled = await catalog.cancel(cancel.workId, "superseded by operator", cancel.revision);
  assert.equal(cancelled.status, "cancelled");

  const review = byRuntime(items, "review");
  const claimed = await catalog.claim(review.workId, "human-review", review.revision);
  await assert.rejects(
    () => catalog.cancel(claimed.workId, "too late", claimed.revision),
    /cannot be cancelled/i,
  );
});

test("work materialization is create-only and returned records are detached", async () => {
  const { catalog, work } = await fixture();
  const items = await catalog.materialize("reconcile-1");
  items[0].reason = "mutated locally";
  assert.notEqual((await catalog.get(items[0].workId)).reason, "mutated locally");

  await assert.rejects(
    () => catalog.materialize("reconcile-1"),
    /already exists/i,
  );
  assert.equal((await work.list()).length, 4);
});
