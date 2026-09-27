import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryRuntimePostureResponseStore,
  MemoryRuntimePostureSnapshotStore,
  RuntimePosturePolicyRegistry,
  RuntimePostureResponseCatalog,
} from "../dist/index.js";

const clock = () => new Date("2026-01-01T00:00:00.000Z");

function snapshot(id, state = "drifted") {
  return {
    format: "nublox-metaobject-runtime-posture",
    formatVersion: 1,
    snapshotId: id,
    runtimeId: "runtime-1",
    state,
    profileId: "profile",
    profileVersion: 2,
    deploymentId: "deployment-1",
    evidenceDeploymentRevision: 3,
    currentDeploymentRevision: 3,
    attestationId: "attestation-1",
    baselineId: "baseline-1",
    assessmentId: "assessment-1",
    driftOutcome: state === "drifted" ? "drift" : "clean",
    message: "runtime posture",
    capturedAt: "2026-01-01T00:00:00.000Z",
  };
}

async function harness(...policies) {
  const snapshots = new MemoryRuntimePostureSnapshotStore();
  await snapshots.create(snapshot("snapshot-1"));
  const responses = new MemoryRuntimePostureResponseStore();
  const registry = new RuntimePosturePolicyRegistry();
  for (const policy of policies) registry.register(policy);
  return { snapshots, responses, registry };
}

test("posture policies are ordered and strongest action wins", async () => {
  const calls = [];
  const { snapshots, responses, registry } = await harness(
    {
      id: "observe",
      evaluate: () => {
        calls.push("observe");
        return { action: "ignore" };
      },
    },
    {
      id: "notify",
      evaluate: () => {
        calls.push("notify");
        return { action: "notify", message: "Notify operations." };
      },
    },
  );
  const catalog = new RuntimePostureResponseCatalog(snapshots, responses, registry, undefined, clock);
  const record = await catalog.evaluate({ responseId: "response-1", snapshotId: "snapshot-1" });

  assert.deepEqual(calls, ["observe", "notify"]);
  assert.equal(record.disposition, "notify");
  assert.deepEqual(record.decisions.map((decision) => decision.policyId), ["observe", "notify"]);

  record.decisions[0].policyId = "tampered";
  const persisted = await responses.get("response-1");
  assert.equal(persisted.decisions[0].policyId, "observe");
});

test("policy exceptions fail closed to review while later policies still execute", async () => {
  let laterRan = false;
  const { snapshots, responses, registry } = await harness(
    { id: "broken", evaluate: () => { throw new Error("policy unavailable"); } },
    {
      id: "later",
      evaluate: () => {
        laterRan = true;
        return { action: "ignore" };
      },
    },
  );
  const catalog = new RuntimePostureResponseCatalog(snapshots, responses, registry, undefined, clock);
  const record = await catalog.evaluate({ responseId: "response-2", snapshotId: "snapshot-1" });

  assert.equal(laterRan, true);
  assert.equal(record.disposition, "review");
  assert.match(record.decisions[0].message, /failed closed/i);
});

test("remediation policy prepares a governed M24 plan without executing it", async () => {
  const { snapshots, responses, registry } = await harness({
    id: "repair-drift",
    evaluate: () => ({ action: "remediate", message: "Repair unauthorized drift." }),
  });
  const calls = [];
  const remediation = {
    async plan(assessmentId, remediationPlanId) {
      calls.push([assessmentId, remediationPlanId]);
      return {
        remediationPlanId,
        assessmentId,
        baselineId: "baseline-1",
        deploymentId: "deployment-1",
        deploymentRevision: 3,
        profileId: "profile",
        profileVersion: 2,
        disposition: "remediate",
        requiresManualReview: false,
        requiresBaselineRefresh: false,
        decisions: [],
        steps: [],
        executionPlan: { format: "nublox-metaobject-runtime-profile-upgrade", formatVersion: 1 },
        createdAt: "2026-01-01T00:00:00.000Z",
      };
    },
  };
  const catalog = new RuntimePostureResponseCatalog(snapshots, responses, registry, remediation, clock);
  const record = await catalog.evaluate({
    responseId: "response-3",
    snapshotId: "snapshot-1",
    remediationPlanId: "repair-plan-1",
  });

  assert.deepEqual(calls, [["assessment-1", "repair-plan-1"]]);
  assert.equal(record.disposition, "remediate");
  assert.equal(record.remediationPlanId, "repair-plan-1");
  assert.equal(record.remediationPlanDisposition, "remediate");
});

test("remediation request without governed planner falls back to review", async () => {
  const { snapshots, responses, registry } = await harness({
    id: "repair-drift",
    evaluate: () => ({ action: "remediate", message: "Repair drift." }),
  });
  const catalog = new RuntimePostureResponseCatalog(snapshots, responses, registry, undefined, clock);
  const record = await catalog.evaluate({ responseId: "response-4", snapshotId: "snapshot-1" });

  assert.equal(record.disposition, "review");
  assert.equal(record.decisions.at(-1).policyId, "$framework");
});

test("only the latest posture snapshot for a runtime may be evaluated", async () => {
  const { snapshots, responses, registry } = await harness({ id: "observe", evaluate: () => ({ action: "ignore" }) });
  await snapshots.create({ ...snapshot("snapshot-2"), capturedAt: "2026-01-02T00:00:00.000Z" });
  const catalog = new RuntimePostureResponseCatalog(snapshots, responses, registry, undefined, clock);

  await assert.rejects(
    () => catalog.evaluate({ responseId: "response-5", snapshotId: "snapshot-1" }),
    /not the latest snapshot/i,
  );
});
