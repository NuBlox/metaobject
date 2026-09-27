import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryRuntimeControlCycleStore,
  RuntimeControlCycleCatalog,
} from "../dist/index.js";

const clock = () => new Date("2026-01-01T00:00:00.000Z");

function assessment() {
  return {
    format: "nublox-metaobject-runtime-drift-assessment",
    formatVersion: 1,
    assessmentId: "assessment-1",
    baselineId: "baseline-1",
    deploymentId: "deployment-1",
    deploymentRevision: 1,
    deploymentCreatedAt: "2026-01-01T00:00:00.000Z",
    outcome: "drift",
    checks: [{ probeId: "schema", status: "changed", baselineFingerprint: "a", currentFingerprint: "b" }],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function posture() {
  return {
    format: "nublox-metaobject-runtime-posture",
    formatVersion: 1,
    snapshotId: "snapshot-1",
    runtimeId: "runtime-1",
    state: "drifted",
    profileId: "profile",
    profileVersion: 2,
    deploymentId: "deployment-1",
    evidenceDeploymentRevision: 1,
    currentDeploymentRevision: 1,
    attestationId: "attestation-1",
    baselineId: "baseline-1",
    assessmentId: "assessment-1",
    driftOutcome: "drift",
    message: "drift detected",
    capturedAt: "2026-01-01T00:00:00.000Z",
  };
}

function response() {
  return {
    format: "nublox-metaobject-runtime-posture-response",
    formatVersion: 1,
    responseId: "response-1",
    runtimeId: "runtime-1",
    snapshotId: "snapshot-1",
    snapshotState: "drifted",
    assessmentId: "assessment-1",
    disposition: "notify",
    decisions: [{ policyId: "policy", action: "notify", message: "notify" }],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

const request = {
  cycleId: "cycle-1",
  runtimeId: "runtime-1",
  baselineId: "baseline-1",
  assessmentId: "assessment-1",
  snapshotId: "snapshot-1",
  responseId: "response-1",
};

test("control cycle links assessment, posture and response into immutable evidence", async () => {
  const calls = [];
  const store = new MemoryRuntimeControlCycleStore();
  const catalog = new RuntimeControlCycleCatalog(
    store,
    { assess: async (...args) => { calls.push(["assessment", ...args]); return assessment(); } },
    { capture: async (input) => { calls.push(["posture", input]); return posture(); } },
    { evaluate: async (input) => { calls.push(["response", input]); return response(); } },
    clock,
  );

  const record = await catalog.run(request);
  assert.equal(record.status, "completed");
  assert.equal(record.assessmentOutcome, "drift");
  assert.equal(record.postureState, "drifted");
  assert.equal(record.responseDisposition, "notify");
  assert.equal(calls[0][0], "assessment");
  assert.equal(calls[1][0], "posture");
  assert.equal(calls[2][0], "response");

  record.runtimeId = "tampered";
  assert.equal((await store.get("cycle-1")).runtimeId, "runtime-1");
  await assert.rejects(() => catalog.run(request), /already exists/i);
});

test("control cycle persists the failed stage when posture capture fails", async () => {
  const store = new MemoryRuntimeControlCycleStore();
  let responseCalled = false;
  const catalog = new RuntimeControlCycleCatalog(
    store,
    { assess: async () => assessment() },
    { capture: async () => { throw new Error("posture unavailable"); } },
    { evaluate: async () => { responseCalled = true; return response(); } },
    clock,
  );

  const record = await catalog.run(request);
  assert.equal(record.status, "failed");
  assert.equal(record.failedStage, "posture");
  assert.match(record.error, /posture unavailable/);
  assert.equal(record.assessmentOutcome, "drift");
  assert.equal(responseCalled, false);
});

test("control cycle rejects mismatched posture identity as a posture-stage failure", async () => {
  const store = new MemoryRuntimeControlCycleStore();
  const catalog = new RuntimeControlCycleCatalog(
    store,
    { assess: async () => assessment() },
    { capture: async () => ({ ...posture(), runtimeId: "other-runtime" }) },
    { evaluate: async () => response() },
    clock,
  );

  const record = await catalog.run(request);
  assert.equal(record.status, "failed");
  assert.equal(record.failedStage, "posture");
  assert.match(record.error, /does not match/i);
});
