import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryRuntimeFleetControlRunStore,
  RuntimeFleetControlCatalog,
} from "../dist/index.js";

function target(runtimeId, revision = 1, status = "active") {
  return {
    format: "nublox-metaobject-runtime-target",
    formatVersion: 1,
    runtimeId,
    revision,
    status,
    desiredProfile: { profileId: "production", profileVersion: 2 },
    createdAt: "2026-09-27T10:00:00.000Z",
    updatedAt: "2026-09-27T10:00:00.000Z",
    ...(status === "retired" ? { retiredAt: "2026-09-27T10:01:00.000Z" } : {}),
  };
}

function request(runtimeId, cycleId, expectedTargetRevision = 1) {
  return {
    runtimeId,
    expectedTargetRevision,
    cycleId,
    baselineId: `baseline-${runtimeId}`,
    assessmentId: `assessment-${runtimeId}`,
    snapshotId: `snapshot-${runtimeId}`,
    responseId: `response-${runtimeId}`,
  };
}

class FakeRegistry {
  constructor(records) { this.records = new Map(records.map((item) => [item.runtimeId, structuredClone(item)])); }
  async get(runtimeId) { return this.records.has(runtimeId) ? structuredClone(this.records.get(runtimeId)) : null; }
  async observeControlCycle(runtimeId, _cycleId, expectedRevision) {
    const current = this.records.get(runtimeId);
    if (current.revision !== expectedRevision) throw new Error("registry revision changed");
    const updated = { ...current, revision: current.revision + 1 };
    this.records.set(runtimeId, structuredClone(updated));
    return structuredClone(updated);
  }
}

class FakeRunner {
  constructor(statuses = {}) { this.statuses = statuses; this.calls = []; }
  async run(input) {
    this.calls.push(structuredClone(input));
    const status = this.statuses[input.runtimeId] ?? "completed";
    return {
      format: "nublox-metaobject-runtime-control-cycle",
      formatVersion: 1,
      ...input,
      status,
      ...(status === "completed"
        ? { assessmentOutcome: "clean", postureState: "verified", responseDisposition: "no-action" }
        : { failedStage: "assessment", error: "probe failed" }),
      startedAt: "2026-09-27T10:02:00.000Z",
      completedAt: "2026-09-27T10:02:01.000Z",
    };
  }
}

function catalog(records, statuses = {}) {
  const store = new MemoryRuntimeFleetControlRunStore();
  const registry = new FakeRegistry(records);
  const runner = new FakeRunner(statuses);
  let tick = 0;
  const fleet = new RuntimeFleetControlCatalog(store, registry, runner, () => new Date(`2026-09-27T10:10:0${tick++}.000Z`));
  return { store, registry, runner, fleet };
}

test("fleet run completes all eligible runtimes and advances target revisions", async () => {
  const { fleet, registry, runner } = catalog([target("a"), target("b")]);
  const result = await fleet.run({ fleetRunId: "fleet-1", targets: [request("a", "cycle-a"), request("b", "cycle-b")] });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.targets.map((item) => item.status), ["completed", "completed"]);
  assert.equal(runner.calls.length, 2);
  assert.equal((await registry.get("a")).revision, 2);
  assert.equal((await registry.get("b")).revision, 2);
});

test("stale and retired targets are isolated while other runtimes continue", async () => {
  const { fleet, runner } = catalog([target("a", 2), target("b"), target("c", 1, "retired")]);
  const result = await fleet.run({
    fleetRunId: "fleet-partial",
    targets: [request("a", "cycle-a", 1), request("b", "cycle-b"), request("c", "cycle-c")],
  });
  assert.equal(result.status, "partial");
  assert.deepEqual(result.targets.map((item) => item.status), ["registry-failed", "completed", "registry-failed"]);
  assert.deepEqual(runner.calls.map((call) => call.runtimeId), ["b"]);
});

test("failed M29 cycles are persisted as target failures without aborting the batch", async () => {
  const { fleet } = catalog([target("a"), target("b")], { a: "failed" });
  const result = await fleet.run({ fleetRunId: "fleet-cycle-fail", targets: [request("a", "cycle-a"), request("b", "cycle-b")] });
  assert.equal(result.status, "partial");
  assert.equal(result.targets[0].status, "cycle-failed");
  assert.match(result.targets[0].error, /probe failed/i);
  assert.equal(result.targets[1].status, "completed");
});

test("rejects duplicate runtime or cycle ids before executing anything", async () => {
  const { fleet, runner } = catalog([target("a"), target("b")]);
  await assert.rejects(
    () => fleet.run({ fleetRunId: "duplicates", targets: [request("a", "same"), request("a", "other")] }),
    /duplicate runtime target/i,
  );
  assert.equal(runner.calls.length, 0);
  await assert.rejects(
    () => fleet.run({ fleetRunId: "duplicates-2", targets: [request("a", "same"), request("b", "same")] }),
    /duplicate control cycle id/i,
  );
});

test("fleet run history is create-only and detached", async () => {
  const { fleet } = catalog([target("a")]);
  const result = await fleet.run({ fleetRunId: "fleet-history", targets: [request("a", "cycle-a")] });
  result.targets[0].status = "registry-failed";
  const persisted = await fleet.get("fleet-history");
  assert.equal(persisted.targets[0].status, "completed");
  await assert.rejects(
    () => fleet.run({ fleetRunId: "fleet-history", targets: [request("a", "cycle-next", 2)] }),
    /already exists/i,
  );
});
