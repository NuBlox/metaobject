import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryRuntimeDeploymentAttestationStore,
  MemoryRuntimeDeploymentDriftAssessmentStore,
  MemoryRuntimeDeploymentDriftBaselineStore,
  MemoryRuntimeDeploymentStore,
  MemoryRuntimeDriftRemediationCaseStore,
  MemoryRuntimePostureSnapshotStore,
  RuntimePostureCatalog,
} from "../dist/index.js";

function completedDeployment(id = "runtime-deployment") {
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

async function fixture(outcome = "clean", suffix = "1") {
  const deployments = new MemoryRuntimeDeploymentStore();
  const deployment = await deployments.save(completedDeployment(`deployment-${suffix}`));
  const attestations = new MemoryRuntimeDeploymentAttestationStore();
  const attestation = await attestations.create({
    format: "nublox-metaobject-runtime-deployment-attestation",
    formatVersion: 1,
    attestationId: `attestation-${suffix}`,
    deploymentId: deployment.deploymentId,
    deploymentRevision: deployment.revision,
    deploymentCreatedAt: deployment.createdAt,
    profileId: "production",
    fromProfileVersion: 1,
    toProfileVersion: 2,
    outcome: "pass",
    checks: [{ verifierId: "schema", outcome: "pass" }],
    journalSequence: 2,
    createdAt: "2026-01-01T00:02:00.000Z",
  });
  const baselines = new MemoryRuntimeDeploymentDriftBaselineStore();
  const baseline = await baselines.create({
    format: "nublox-metaobject-runtime-drift-baseline",
    formatVersion: 1,
    baselineId: `baseline-${suffix}`,
    attestationId: attestation.attestationId,
    deploymentId: deployment.deploymentId,
    deploymentRevision: deployment.revision,
    deploymentCreatedAt: deployment.createdAt,
    profileId: "production",
    profileVersion: 2,
    fingerprints: [{ probeId: "schema", fingerprint: "schema:v2" }],
    createdAt: "2026-01-01T00:03:00.000Z",
  });
  const assessments = new MemoryRuntimeDeploymentDriftAssessmentStore();
  const checks = outcome === "clean"
    ? [{ probeId: "schema", status: "unchanged", baselineFingerprint: "schema:v2", currentFingerprint: "schema:v2" }]
    : outcome === "warning"
      ? [{ probeId: "schema", status: "unverifiable", baselineFingerprint: "schema:v2", message: "probe unavailable" }]
      : [{ probeId: "schema", status: "changed", baselineFingerprint: "schema:v2", currentFingerprint: "schema:hotfix" }];
  const assessment = await assessments.create({
    format: "nublox-metaobject-runtime-drift-assessment",
    formatVersion: 1,
    assessmentId: `assessment-${suffix}`,
    baselineId: baseline.baselineId,
    deploymentId: deployment.deploymentId,
    deploymentRevision: deployment.revision,
    deploymentCreatedAt: deployment.createdAt,
    outcome,
    checks,
    createdAt: "2026-01-01T00:04:00.000Z",
  });
  const remediationCases = new MemoryRuntimeDriftRemediationCaseStore();
  const snapshots = new MemoryRuntimePostureSnapshotStore();
  const posture = new RuntimePostureCatalog(
    snapshots,
    deployments,
    attestations,
    baselines,
    assessments,
    remediationCases,
    () => new Date("2026-01-01T00:05:00.000Z"),
  );
  return { deployments, deployment, attestations, attestation, baselines, baseline, assessments, assessment, remediationCases, snapshots, posture };
}

async function capture(parts, snapshotId, remediationCaseId) {
  return parts.posture.capture({
    snapshotId,
    runtimeId: "runtime-production",
    baselineId: parts.baseline.baselineId,
    assessmentId: parts.assessment.assessmentId,
    ...(remediationCaseId === undefined ? {} : { remediationCaseId }),
  });
}

test("clean, warning and drift assessments map to verified runtime posture", async () => {
  const clean = await fixture("clean", "clean");
  assert.equal((await capture(clean, "posture-clean")).state, "verified");

  const warning = await fixture("warning", "warning");
  assert.equal((await capture(warning, "posture-warning")).state, "warning");

  const drift = await fixture("drift", "drift");
  assert.equal((await capture(drift, "posture-drift")).state, "drifted");
});

test("open and review M25 cases override raw drift into actionable posture", async () => {
  const parts = await fixture("drift", "active");
  const active = await parts.remediationCases.save({
    caseId: "case-active",
    status: "deploying",
    revision: 0,
    remediationPlanId: "remediation-active",
    sourceAssessmentId: parts.assessment.assessmentId,
    sourceBaselineId: parts.baseline.baselineId,
    sourceDeploymentId: parts.deployment.deploymentId,
    profileId: "production",
    profileVersion: 2,
    repairDeploymentId: "repair-active",
    createdAt: "2026-01-01T00:04:30.000Z",
    updatedAt: "2026-01-01T00:04:30.000Z",
  });
  const remediating = await capture(parts, "posture-remediating", active.caseId);
  assert.equal(remediating.state, "remediating");

  const review = await parts.remediationCases.save({
    caseId: "case-review",
    status: "review",
    revision: 0,
    remediationPlanId: "remediation-review",
    sourceAssessmentId: parts.assessment.assessmentId,
    sourceBaselineId: parts.baseline.baselineId,
    sourceDeploymentId: parts.deployment.deploymentId,
    profileId: "production",
    profileVersion: 2,
    repairDeploymentId: "repair-review",
    reviewReason: "Repair evidence requires operator review.",
    createdAt: "2026-01-01T00:04:31.000Z",
    updatedAt: "2026-01-01T00:04:31.000Z",
  });
  const reviewing = await capture(parts, "posture-review", review.caseId);
  assert.equal(reviewing.state, "review");
  assert.match(reviewing.message, /operator review/i);
});

test("closed M25 case plus its replacement clean evidence reports restored posture", async () => {
  const parts = await fixture("clean", "restored");
  const closed = await parts.remediationCases.save({
    caseId: "case-closed",
    status: "closed",
    revision: 0,
    remediationPlanId: "remediation-closed",
    sourceAssessmentId: "assessment-original-drift",
    sourceBaselineId: "baseline-original",
    sourceDeploymentId: "deployment-original",
    profileId: "production",
    profileVersion: 2,
    repairDeploymentId: parts.deployment.deploymentId,
    repairAttestationId: parts.attestation.attestationId,
    replacementBaselineId: parts.baseline.baselineId,
    closureAssessmentId: parts.assessment.assessmentId,
    createdAt: "2026-01-01T00:04:20.000Z",
    updatedAt: "2026-01-01T00:04:40.000Z",
    closedAt: "2026-01-01T00:04:40.000Z",
  });
  const snapshot = await capture(parts, "posture-restored", closed.caseId);
  assert.equal(snapshot.state, "restored");
  assert.equal(snapshot.remediationCaseStatus, "closed");
});

test("changed deployment after evidence makes ordinary/restored posture stale", async () => {
  const parts = await fixture("clean", "stale");
  await parts.deployments.save({
    ...parts.deployment,
    updatedAt: "2026-01-01T00:06:00.000Z",
  }, parts.deployment.revision);
  const snapshot = await capture(parts, "posture-stale");
  assert.equal(snapshot.state, "stale");
  assert.equal(snapshot.evidenceDeploymentRevision, parts.deployment.revision);
  assert.equal(snapshot.currentDeploymentRevision, parts.deployment.revision + 1);
});

test("posture snapshots are immutable history with deterministic latest selection", async () => {
  const parts = await fixture("clean", "history");
  const first = await capture(parts, "posture-history-1");
  first.message = "mutated locally";
  const persisted = await parts.snapshots.get(first.snapshotId);
  assert.notEqual(persisted.message, "mutated locally");

  const secondCatalog = new RuntimePostureCatalog(
    parts.snapshots,
    parts.deployments,
    parts.attestations,
    parts.baselines,
    parts.assessments,
    parts.remediationCases,
    () => new Date("2026-01-01T00:06:00.000Z"),
  );
  await secondCatalog.capture({
    snapshotId: "posture-history-2",
    runtimeId: "runtime-production",
    baselineId: parts.baseline.baselineId,
    assessmentId: parts.assessment.assessmentId,
  });
  const history = await secondCatalog.history("runtime-production");
  assert.deepEqual(history.map((item) => item.snapshotId), ["posture-history-1", "posture-history-2"]);
  assert.equal((await secondCatalog.latest("runtime-production")).snapshotId, "posture-history-2");
  await assert.rejects(
    () => secondCatalog.capture({
      snapshotId: "posture-history-2",
      runtimeId: "runtime-production",
      baselineId: parts.baseline.baselineId,
      assessmentId: parts.assessment.assessmentId,
    }),
    /already exists/i,
  );
});

test("posture rejects evidence and remediation cases from different chains", async () => {
  const parts = await fixture("drift", "mismatch");
  const other = await parts.remediationCases.save({
    caseId: "case-other",
    status: "deploying",
    revision: 0,
    remediationPlanId: "remediation-other",
    sourceAssessmentId: "different-assessment",
    sourceBaselineId: "different-baseline",
    sourceDeploymentId: "different-deployment",
    profileId: "production",
    profileVersion: 2,
    repairDeploymentId: "repair-other",
    createdAt: "2026-01-01T00:04:30.000Z",
    updatedAt: "2026-01-01T00:04:30.000Z",
  });
  await assert.rejects(
    () => capture(parts, "posture-mismatch", other.caseId),
    /does not originate from the supplied assessment\/baseline\/deployment chain/i,
  );
});
