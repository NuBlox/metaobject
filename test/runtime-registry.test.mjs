import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryRuntimeTargetStore,
  RuntimeTargetCatalog,
} from "../dist/index.js";

class MapSource {
  constructor(records = [], key = "snapshotId") {
    this.records = new Map(records.map((record) => [record[key], structuredClone(record)]));
  }
  async get(id) { return this.records.has(id) ? structuredClone(this.records.get(id)) : null; }
  set(id, value) { this.records.set(id, structuredClone(value)); }
}

function posture(overrides = {}) {
  return {
    format: "nublox-metaobject-runtime-posture",
    formatVersion: 1,
    snapshotId: "snapshot-1",
    runtimeId: "runtime-a",
    state: "verified",
    profileId: "production",
    profileVersion: 2,
    deploymentId: "deployment-1",
    evidenceDeploymentRevision: 3,
    currentDeploymentRevision: 3,
    attestationId: "attestation-1",
    baselineId: "baseline-1",
    assessmentId: "assessment-1",
    driftOutcome: "clean",
    message: "clean",
    capturedAt: "2026-09-27T09:00:00.000Z",
    ...overrides,
  };
}

function completedCycle(overrides = {}) {
  return {
    format: "nublox-metaobject-runtime-control-cycle",
    formatVersion: 1,
    cycleId: "cycle-1",
    runtimeId: "runtime-a",
    baselineId: "baseline-1",
    assessmentId: "assessment-1",
    snapshotId: "snapshot-1",
    responseId: "response-1",
    status: "completed",
    assessmentOutcome: "clean",
    postureState: "verified",
    responseDisposition: "no-action",
    startedAt: "2026-09-27T09:00:00.000Z",
    completedAt: "2026-09-27T09:00:01.000Z",
    ...overrides,
  };
}

function failedCycle(overrides = {}) {
  return {
    format: "nublox-metaobject-runtime-control-cycle",
    formatVersion: 1,
    cycleId: "cycle-failed",
    runtimeId: "runtime-a",
    baselineId: "baseline-1",
    assessmentId: "assessment-failed",
    snapshotId: "snapshot-failed",
    responseId: "response-failed",
    status: "failed",
    failedStage: "assessment",
    error: "probe unavailable",
    startedAt: "2026-09-27T09:05:00.000Z",
    completedAt: "2026-09-27T09:05:01.000Z",
    ...overrides,
  };
}

function fixture() {
  const store = new MemoryRuntimeTargetStore();
  const postures = new MapSource([posture()], "snapshotId");
  const cycles = new MapSource([completedCycle(), failedCycle()], "cycleId");
  let tick = 0;
  const catalog = new RuntimeTargetCatalog(store, postures, cycles, () => new Date(`2026-09-27T10:00:0${tick++}.000Z`));
  return { store, postures, cycles, catalog };
}

test("registers runtimes and updates desired profile with optimistic concurrency", async () => {
  const { catalog } = fixture();
  const created = await catalog.register({ runtimeId: "runtime-a", profileId: "production", profileVersion: 2 });
  assert.equal(created.revision, 1);
  assert.deepEqual(created.desiredProfile, { profileId: "production", profileVersion: 2 });

  const updated = await catalog.setDesiredProfile("runtime-a", "production", 3, created.revision);
  assert.equal(updated.revision, 2);
  assert.equal(updated.desiredProfile.profileVersion, 3);
  await assert.rejects(
    () => catalog.setDesiredProfile("runtime-a", "production", 4, created.revision),
    /concurrency conflict/i,
  );
});

test("observes trusted posture and reports fleet summary", async () => {
  const { catalog } = fixture();
  const created = await catalog.register({ runtimeId: "runtime-a", profileId: "production", profileVersion: 2 });
  const observed = await catalog.observePosture("runtime-a", "snapshot-1", created.revision);
  assert.equal(observed.observation.postureState, "verified");
  assert.equal(observed.observation.baselineId, "baseline-1");

  await catalog.register({ runtimeId: "runtime-b", profileId: "staging", profileVersion: 1 });
  const summary = await catalog.summary();
  assert.equal(summary.total, 2);
  assert.equal(summary.active, 2);
  assert.equal(summary.posture.verified, 1);
  assert.equal(summary.posture.unobserved, 1);
});

test("completed control cycle advances observation while failed cycle preserves trusted posture", async () => {
  const { catalog } = fixture();
  const created = await catalog.register({ runtimeId: "runtime-a", profileId: "production", profileVersion: 2 });
  const completed = await catalog.observeControlCycle("runtime-a", "cycle-1", created.revision);
  assert.equal(completed.observation.controlCycleId, "cycle-1");
  assert.equal(completed.observation.responseDisposition, "no-action");
  assert.equal(completed.lastControlCycle.status, "completed");

  const failed = await catalog.observeControlCycle("runtime-a", "cycle-failed", completed.revision);
  assert.equal(failed.lastControlCycle.status, "failed");
  assert.equal(failed.lastControlCycle.failedStage, "assessment");
  assert.equal(failed.observation.postureSnapshotId, "snapshot-1");
  assert.equal(failed.observation.controlCycleId, "cycle-1");
});

test("rejects completed cycles whose posture evidence belongs to a different chain", async () => {
  const { catalog, cycles } = fixture();
  cycles.set("cycle-bad", completedCycle({ cycleId: "cycle-bad", assessmentId: "assessment-other" }));
  const created = await catalog.register({ runtimeId: "runtime-a", profileId: "production", profileVersion: 2 });
  await assert.rejects(
    () => catalog.observeControlCycle("runtime-a", "cycle-bad", created.revision),
    /does not match its posture evidence/i,
  );
});

test("rejects evidence from another runtime", async () => {
  const { catalog, postures } = fixture();
  postures.set("snapshot-other", posture({ snapshotId: "snapshot-other", runtimeId: "runtime-b" }));
  const created = await catalog.register({ runtimeId: "runtime-a", profileId: "production", profileVersion: 2 });
  await assert.rejects(
    () => catalog.observePosture("runtime-a", "snapshot-other", created.revision),
    /belongs to runtime 'runtime-b'/i,
  );
});

test("retired runtimes remain readable but cannot be mutated", async () => {
  const { catalog } = fixture();
  const created = await catalog.register({ runtimeId: "runtime-a", profileId: "production", profileVersion: 2 });
  const retired = await catalog.retire("runtime-a", created.revision);
  assert.equal(retired.status, "retired");
  assert.ok(retired.retiredAt);
  assert.equal((await catalog.get("runtime-a")).status, "retired");
  await assert.rejects(
    () => catalog.setDesiredProfile("runtime-a", "production", 3, retired.revision),
    /is retired/i,
  );
});

test("memory store returns detached runtime records", async () => {
  const { catalog } = fixture();
  const created = await catalog.register({ runtimeId: "runtime-a", profileId: "production", profileVersion: 2 });
  created.desiredProfile.profileVersion = 99;
  const persisted = await catalog.get("runtime-a");
  assert.equal(persisted.desiredProfile.profileVersion, 2);
});
