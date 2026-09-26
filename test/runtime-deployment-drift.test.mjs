import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryRuntimeDeploymentAttestationStore,
  MemoryRuntimeDeploymentDriftAssessmentStore,
  MemoryRuntimeDeploymentDriftBaselineStore,
  MemoryRuntimeDeploymentStore,
  RuntimeDeploymentDriftCatalog,
  RuntimeDeploymentDriftProbeRegistry,
} from "../dist/index.js";

function completedDeployment(id = "deploy-drift") {
  return {
    deploymentId: id,
    status: "completed",
    revision: 0,
    profileId: "production",
    fromProfileVersion: 1,
    toProfileVersion: 2,
    plan: {
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
      steps: [],
    },
    steps: [],
    journal: [
      { sequence: 1, kind: "deployment-created", occurredAt: "2026-01-01T00:00:00.000Z" },
      { sequence: 2, kind: "deployment-completed", occurredAt: "2026-01-01T00:01:00.000Z" },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
  };
}

async function fixture() {
  const deployments = new MemoryRuntimeDeploymentStore();
  const deployment = await deployments.save(completedDeployment());
  const attestations = new MemoryRuntimeDeploymentAttestationStore();
  const attestation = await attestations.create({
    format: "nublox-metaobject-runtime-deployment-attestation",
    formatVersion: 1,
    attestationId: "att-drift",
    deploymentId: deployment.deploymentId,
    deploymentRevision: deployment.revision,
    profileId: deployment.profileId,
    fromProfileVersion: deployment.fromProfileVersion,
    toProfileVersion: deployment.toProfileVersion,
    outcome: "pass",
    checks: [{ verifierId: "schema-attestation", outcome: "pass" }],
    journalSequence: 2,
    createdAt: "2026-01-01T00:02:00.000Z",
  });
  return { deployments, deployment, attestations, attestation };
}

function catalog(parts, probes) {
  return new RuntimeDeploymentDriftCatalog(
    parts.deployments,
    parts.attestations,
    new MemoryRuntimeDeploymentDriftBaselineStore(),
    new MemoryRuntimeDeploymentDriftAssessmentStore(),
    probes,
    () => new Date("2026-01-01T00:03:00.000Z"),
  );
}

test("baseline captures ordered deterministic fingerprints and reassesses cleanly", async () => {
  const parts = await fixture();
  const probes = new RuntimeDeploymentDriftProbeRegistry()
    .register({ id: "schema", inspect: () => ({ fingerprint: "schema:v2" }) })
    .register({ id: "config", inspect: () => ({ fingerprint: "config:abc" }) });
  const drift = catalog(parts, probes);
  const baseline = await drift.createBaseline("att-drift", "base-1");
  assert.deepEqual(baseline.fingerprints.map((item) => item.probeId), ["schema", "config"]);
  const assessment = await drift.assess("base-1", "assessment-clean");
  assert.equal(assessment.outcome, "clean");
  assert.deepEqual(assessment.checks.map((item) => item.status), ["unchanged", "unchanged"]);
});

test("changed fingerprints produce drift", async () => {
  const parts = await fixture();
  let schema = "schema:v2";
  const probes = new RuntimeDeploymentDriftProbeRegistry()
    .register({ id: "schema", inspect: () => ({ fingerprint: schema }) });
  const drift = catalog(parts, probes);
  await drift.createBaseline("att-drift", "base-change");
  schema = "schema:v2-hotfix";
  const assessment = await drift.assess("base-change", "assessment-drift");
  assert.equal(assessment.outcome, "drift");
  assert.equal(assessment.checks[0].status, "changed");
  assert.equal(assessment.checks[0].baselineFingerprint, "schema:v2");
  assert.equal(assessment.checks[0].currentFingerprint, "schema:v2-hotfix");
});

test("probe failures during assessment are warnings rather than false clean results", async () => {
  const parts = await fixture();
  let fail = false;
  const probes = new RuntimeDeploymentDriftProbeRegistry()
    .register({ id: "health", inspect: () => {
      if (fail) throw new Error("health endpoint unavailable");
      return { fingerprint: "healthy" };
    } });
  const drift = catalog(parts, probes);
  await drift.createBaseline("att-drift", "base-warning");
  fail = true;
  const assessment = await drift.assess("base-warning", "assessment-warning");
  assert.equal(assessment.outcome, "warning");
  assert.equal(assessment.checks[0].status, "unverifiable");
  assert.match(assessment.checks[0].message, /endpoint unavailable/i);
});

test("failed attestations cannot establish drift baselines", async () => {
  const parts = await fixture();
  await parts.attestations.create({
    format: "nublox-metaobject-runtime-deployment-attestation",
    formatVersion: 1,
    attestationId: "att-failed",
    deploymentId: parts.deployment.deploymentId,
    deploymentRevision: parts.deployment.revision,
    profileId: parts.deployment.profileId,
    fromProfileVersion: 1,
    toProfileVersion: 2,
    outcome: "fail",
    checks: [{ verifierId: "schema", outcome: "fail", message: "Schema mismatch" }],
    journalSequence: 2,
    createdAt: "2026-01-01T00:02:00.000Z",
  });
  const drift = catalog(parts, new RuntimeDeploymentDriftProbeRegistry().register({ id: "schema", inspect: () => ({ fingerprint: "v2" }) }));
  await assert.rejects(() => drift.createBaseline("att-failed", "base-failed"), /cannot establish a drift baseline/i);
});
