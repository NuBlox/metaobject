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

function deployment(id = "posture-integrity-deployment") {
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

async function evidenceFixture(outcome = "clean") {
  const deployments = new MemoryRuntimeDeploymentStore();
  const stored = await deployments.save(deployment());
  const attestations = new MemoryRuntimeDeploymentAttestationStore();
  const attestation = await attestations.create({
    format: "nublox-metaobject-runtime-deployment-attestation",
    formatVersion: 1,
    attestationId: "att-integrity",
    deploymentId: stored.deploymentId,
    deploymentRevision: stored.revision,
    deploymentCreatedAt: stored.createdAt,
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
    baselineId: "baseline-integrity",
    attestationId: attestation.attestationId,
    deploymentId: stored.deploymentId,
    deploymentRevision: stored.revision,
    deploymentCreatedAt: stored.createdAt,
    profileId: "production",
    profileVersion: 2,
    fingerprints: [{ probeId: "schema", fingerprint: "schema:v2" }],
    createdAt: "2026-01-01T00:03:00.000Z",
  });
  const assessments = new MemoryRuntimeDeploymentDriftAssessmentStore();
  const checks = outcome === "clean"
    ? [{ probeId: "schema", status: "unchanged", baselineFingerprint: "schema:v2", currentFingerprint: "schema:v2" }]
    : [{ probeId: "schema", status: "changed", baselineFingerprint: "schema:v2", currentFingerprint: "schema:drift" }];
  const assessment = await assessments.create({
    format: "nublox-metaobject-runtime-drift-assessment",
    formatVersion: 1,
    assessmentId: "assessment-integrity",
    baselineId: baseline.baselineId,
    deploymentId: stored.deploymentId,
    deploymentRevision: stored.revision,
    deploymentCreatedAt: stored.createdAt,
    outcome,
    checks,
    createdAt: "2026-01-01T00:04:00.000Z",
  });
  return { deployments, stored, attestations, attestation, baselines, baseline, assessments, assessment };
}

function catalog(parts, cases = new MemoryRuntimeDriftRemediationCaseStore(), snapshots = new MemoryRuntimePostureSnapshotStore()) {
  return new RuntimePostureCatalog(
    snapshots,
    parts.deployments,
    parts.attestations,
    parts.baselines,
    parts.assessments,
    cases,
    () => new Date("2026-01-01T00:05:00.000Z"),
  );
}

test("posture rejects evidence records bound to different deployment revisions or incarnations", async () => {
  const parts = await evidenceFixture();
  const inconsistentBaseline = await parts.baselines.create({
    ...parts.baseline,
    baselineId: "baseline-other-revision",
    deploymentRevision: parts.baseline.deploymentRevision + 1,
  });
  const inconsistentAssessment = await parts.assessments.create({
    ...parts.assessment,
    assessmentId: "assessment-other-revision",
    baselineId: inconsistentBaseline.baselineId,
    deploymentRevision: inconsistentBaseline.deploymentRevision,
  });
  await assert.rejects(
    () => catalog(parts).capture({
      snapshotId: "posture-other-revision",
      runtimeId: "runtime",
      baselineId: inconsistentBaseline.baselineId,
      assessmentId: inconsistentAssessment.assessmentId,
    }),
    /inconsistent deployment revisions/i,
  );

  const inconsistentCreated = await parts.baselines.create({
    ...parts.baseline,
    baselineId: "baseline-other-created",
    deploymentCreatedAt: "2026-01-01T00:10:00.000Z",
  });
  const assessmentCreated = await parts.assessments.create({
    ...parts.assessment,
    assessmentId: "assessment-other-created",
    baselineId: inconsistentCreated.baselineId,
    deploymentCreatedAt: inconsistentCreated.deploymentCreatedAt,
  });
  await assert.rejects(
    () => catalog(parts).capture({
      snapshotId: "posture-other-created",
      runtimeId: "runtime",
      baselineId: inconsistentCreated.baselineId,
      assessmentId: assessmentCreated.assessmentId,
    }),
    /inconsistent deployment creation identity/i,
  );
});

test("closed remediation case cannot report restored from warning or drift closure evidence", async () => {
  const parts = await evidenceFixture("drift");
  const cases = new MemoryRuntimeDriftRemediationCaseStore();
  const closed = await cases.save({
    caseId: "case-invalid-closed",
    status: "closed",
    revision: 0,
    remediationPlanId: "remediation-invalid",
    sourceAssessmentId: "source-assessment",
    sourceBaselineId: "source-baseline",
    sourceDeploymentId: "source-deployment",
    profileId: "production",
    profileVersion: 2,
    repairDeploymentId: parts.stored.deploymentId,
    repairAttestationId: parts.attestation.attestationId,
    replacementBaselineId: parts.baseline.baselineId,
    closureAssessmentId: parts.assessment.assessmentId,
    createdAt: "2026-01-01T00:04:10.000Z",
    updatedAt: "2026-01-01T00:04:20.000Z",
    closedAt: "2026-01-01T00:04:20.000Z",
  });
  await assert.rejects(
    () => catalog(parts, cases).capture({
      snapshotId: "posture-invalid-restored",
      runtimeId: "runtime",
      baselineId: parts.baseline.baselineId,
      assessmentId: parts.assessment.assessmentId,
      remediationCaseId: closed.caseId,
    }),
    /does not have clean unchanged closure evidence/i,
  );
});

test("open remediation case must match source assessment, baseline and deployment", async () => {
  const parts = await evidenceFixture("drift");
  const cases = new MemoryRuntimeDriftRemediationCaseStore();
  const open = await cases.save({
    caseId: "case-wrong-source",
    status: "deploying",
    revision: 0,
    remediationPlanId: "remediation-source",
    sourceAssessmentId: parts.assessment.assessmentId,
    sourceBaselineId: "different-baseline",
    sourceDeploymentId: "different-deployment",
    profileId: "production",
    profileVersion: 2,
    repairDeploymentId: "repair-deployment",
    createdAt: "2026-01-01T00:04:10.000Z",
    updatedAt: "2026-01-01T00:04:10.000Z",
  });
  await assert.rejects(
    () => catalog(parts, cases).capture({
      snapshotId: "posture-wrong-source",
      runtimeId: "runtime",
      baselineId: parts.baseline.baselineId,
      assessmentId: parts.assessment.assessmentId,
      remediationCaseId: open.caseId,
    }),
    /does not originate from the supplied assessment\/baseline\/deployment chain/i,
  );
});

test("deployment is read after asynchronous remediation lookup before posture persistence", async () => {
  const parts = await evidenceFixture("drift");
  const backingCases = new MemoryRuntimeDriftRemediationCaseStore();
  const open = await backingCases.save({
    caseId: "case-race-posture",
    status: "deploying",
    revision: 0,
    remediationPlanId: "remediation-race",
    sourceAssessmentId: parts.assessment.assessmentId,
    sourceBaselineId: parts.baseline.baselineId,
    sourceDeploymentId: parts.stored.deploymentId,
    profileId: "production",
    profileVersion: 2,
    repairDeploymentId: "repair-race",
    createdAt: "2026-01-01T00:04:10.000Z",
    updatedAt: "2026-01-01T00:04:10.000Z",
  });

  const mutatingCases = {
    get: async (caseId) => {
      const result = await backingCases.get(caseId);
      const current = await parts.deployments.get(parts.stored.deploymentId);
      await parts.deployments.save({ ...current, updatedAt: "2026-01-01T00:04:50.000Z" }, current.revision);
      return result;
    },
    list: (filter) => backingCases.list(filter),
    save: (record, expectedRevision) => backingCases.save(record, expectedRevision),
  };

  const snapshot = await catalog(parts, mutatingCases).capture({
    snapshotId: "posture-race",
    runtimeId: "runtime",
    baselineId: parts.baseline.baselineId,
    assessmentId: parts.assessment.assessmentId,
    remediationCaseId: open.caseId,
  });
  // Active remediation intentionally remains visible, but current revision proves
  // capture observed the post-lookup deployment state rather than the stale one.
  assert.equal(snapshot.state, "remediating");
  assert.equal(snapshot.currentDeploymentRevision, parts.stored.revision + 1);
});

test("latest posture is independent of storage list ordering", async () => {
  const parts = await evidenceFixture();
  class ReverseStore extends MemoryRuntimePostureSnapshotStore {
    async list(filter) {
      return [...await super.list(filter)].reverse();
    }
  }
  const snapshots = new ReverseStore();
  const firstCatalog = new RuntimePostureCatalog(
    snapshots,
    parts.deployments,
    parts.attestations,
    parts.baselines,
    parts.assessments,
    new MemoryRuntimeDriftRemediationCaseStore(),
    () => new Date("2026-01-01T00:05:00.000Z"),
  );
  await firstCatalog.capture({
    snapshotId: "posture-first",
    runtimeId: "runtime",
    baselineId: parts.baseline.baselineId,
    assessmentId: parts.assessment.assessmentId,
  });
  const secondCatalog = new RuntimePostureCatalog(
    snapshots,
    parts.deployments,
    parts.attestations,
    parts.baselines,
    parts.assessments,
    new MemoryRuntimeDriftRemediationCaseStore(),
    () => new Date("2026-01-01T00:06:00.000Z"),
  );
  await secondCatalog.capture({
    snapshotId: "posture-second",
    runtimeId: "runtime",
    baselineId: parts.baseline.baselineId,
    assessmentId: parts.assessment.assessmentId,
  });
  assert.equal((await secondCatalog.latest("runtime")).snapshotId, "posture-second");
  assert.deepEqual((await secondCatalog.history("runtime")).map((item) => item.snapshotId), ["posture-first", "posture-second"]);
});
