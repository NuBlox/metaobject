import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryRuntimeDeploymentAttestationStore,
  MemoryRuntimeDeploymentDriftAssessmentStore,
  MemoryRuntimeDeploymentDriftBaselineStore,
  MemoryRuntimeDeploymentStore,
  MemoryRuntimeDriftRemediationCaseStore,
  MemoryRuntimeDriftRemediationPlanStore,
  RuntimeDriftRemediationCaseCatalog,
} from "../dist/index.js";

function executionPlan() {
  return {
    format: "nublox-metaobject-runtime-profile-upgrade",
    formatVersion: 1,
    remediationPlanId: "remediation-integrity",
    assessmentId: "assessment-source",
    baselineId: "baseline-source",
    profileId: "production",
    fromProfileVersion: 2,
    toProfileVersion: 2,
    impact: "compatible",
    requiresManualReview: false,
    blockingStepCount: 0,
    moduleChanges: [],
    objectChanges: [],
    steps: [{
      id: "001:drift:schema:migrate-object-type",
      kind: "migrate-object-type",
      moduleId: "core",
      objectTypeId: "core.settings",
      fromVersion: 2,
      toVersion: 2,
      blocking: false,
      requiresManualReview: false,
      description: "Restore schema.",
    }],
  };
}

function remediationPlan() {
  const plan = executionPlan();
  return {
    format: "nublox-metaobject-runtime-drift-remediation",
    formatVersion: 1,
    remediationPlanId: plan.remediationPlanId,
    assessmentId: plan.assessmentId,
    baselineId: plan.baselineId,
    deploymentId: "source-deployment",
    deploymentRevision: 3,
    profileId: plan.profileId,
    profileVersion: 2,
    disposition: "remediate",
    requiresManualReview: false,
    requiresBaselineRefresh: false,
    decisions: [{
      probeId: "schema",
      checkStatus: "changed",
      classification: "unauthorized",
      action: "remediate",
      message: "Unauthorised schema drift.",
      stepIds: [plan.steps[0].id],
    }],
    steps: plan.steps,
    executionPlan: plan,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function repairDeployment(plan) {
  return {
    deploymentId: "repair-integrity",
    status: "completed",
    revision: 0,
    profileId: "production",
    fromProfileVersion: 2,
    toProfileVersion: 2,
    plan,
    steps: [{ stepId: plan.steps[0].id, status: "completed", attempts: 1 }],
    journal: [
      { sequence: 1, kind: "deployment-created", occurredAt: "2026-01-01T00:01:00.000Z" },
      { sequence: 2, kind: "deployment-completed", occurredAt: "2026-01-01T00:02:00.000Z" },
    ],
    createdAt: "2026-01-01T00:01:00.000Z",
    updatedAt: "2026-01-01T00:02:00.000Z",
    completedAt: "2026-01-01T00:02:00.000Z",
  };
}

class ClosureRaceDeploymentStore extends MemoryRuntimeDeploymentStore {
  armed = false;
  reads = 0;

  arm() {
    this.armed = true;
    this.reads = 0;
  }

  async get(identity) {
    const record = await super.get(identity);
    if (this.armed) {
      this.reads += 1;
      if (this.reads === 2 && record) {
        await super.save({ ...record, updatedAt: "2026-01-01T00:09:30.000Z" }, record.revision);
      }
    }
    return record;
  }
}

async function fixture(DeploymentStore = MemoryRuntimeDeploymentStore) {
  const plans = new MemoryRuntimeDriftRemediationPlanStore();
  const plan = await plans.create(remediationPlan());
  const deployments = new DeploymentStore();
  const repair = await deployments.save(repairDeployment(plan.executionPlan));
  const attestations = new MemoryRuntimeDeploymentAttestationStore();
  const baselines = new MemoryRuntimeDeploymentDriftBaselineStore();
  const assessments = new MemoryRuntimeDeploymentDriftAssessmentStore();
  const cases = new MemoryRuntimeDriftRemediationCaseStore();
  const catalog = new RuntimeDriftRemediationCaseCatalog(
    cases,
    plans,
    deployments,
    attestations,
    baselines,
    assessments,
    () => new Date("2026-01-01T00:10:00.000Z"),
  );
  return { plans, plan, deployments, repair, attestations, baselines, assessments, cases, catalog };
}

async function prepareVerifyingCase(parts, id = "case-integrity") {
  let record = await parts.catalog.create(id, parts.plan.remediationPlanId);
  record = await parts.catalog.linkDeployment(record.caseId, parts.repair.deploymentId, record.revision);
  const attestation = await parts.attestations.create({
    format: "nublox-metaobject-runtime-deployment-attestation",
    formatVersion: 1,
    attestationId: `${id}-attestation`,
    deploymentId: parts.repair.deploymentId,
    deploymentRevision: parts.repair.revision,
    deploymentCreatedAt: parts.repair.createdAt,
    profileId: "production",
    fromProfileVersion: 2,
    toProfileVersion: 2,
    outcome: "pass",
    checks: [{ verifierId: "schema", outcome: "pass" }],
    journalSequence: 2,
    createdAt: "2026-01-01T00:03:00.000Z",
  });
  record = await parts.catalog.linkAttestation(record.caseId, attestation.attestationId, record.revision);
  const baseline = await parts.baselines.create({
    format: "nublox-metaobject-runtime-drift-baseline",
    formatVersion: 1,
    baselineId: `${id}-baseline`,
    attestationId: attestation.attestationId,
    deploymentId: parts.repair.deploymentId,
    deploymentRevision: parts.repair.revision,
    deploymentCreatedAt: parts.repair.createdAt,
    profileId: "production",
    profileVersion: 2,
    fingerprints: [{ probeId: "schema", fingerprint: "schema:restored" }],
    createdAt: "2026-01-01T00:04:00.000Z",
  });
  const assessment = await parts.assessments.create({
    format: "nublox-metaobject-runtime-drift-assessment",
    formatVersion: 1,
    assessmentId: `${id}-assessment`,
    baselineId: baseline.baselineId,
    deploymentId: parts.repair.deploymentId,
    deploymentRevision: parts.repair.revision,
    deploymentCreatedAt: parts.repair.createdAt,
    outcome: "clean",
    checks: [{
      probeId: "schema",
      status: "unchanged",
      baselineFingerprint: "schema:restored",
      currentFingerprint: "schema:restored",
    }],
    createdAt: "2026-01-01T00:05:00.000Z",
  });
  return { record, attestation, baseline, assessment };
}

test("M25 exact closure rejects legacy attestation without deployment creation identity", async () => {
  const parts = await fixture();
  let record = await parts.catalog.create("case-legacy", parts.plan.remediationPlanId);
  record = await parts.catalog.linkDeployment(record.caseId, parts.repair.deploymentId, record.revision);
  const legacy = await parts.attestations.create({
    format: "nublox-metaobject-runtime-deployment-attestation",
    formatVersion: 1,
    attestationId: "legacy-attestation",
    deploymentId: parts.repair.deploymentId,
    deploymentRevision: parts.repair.revision,
    profileId: "production",
    fromProfileVersion: 2,
    toProfileVersion: 2,
    outcome: "pass",
    checks: [{ verifierId: "schema", outcome: "pass" }],
    journalSequence: 2,
    createdAt: "2026-01-01T00:03:00.000Z",
  });
  await assert.rejects(
    () => parts.catalog.linkAttestation(record.caseId, legacy.attestationId, record.revision),
    /lacks deployment creation identity/i,
  );
});

test("planned remediation cases can enter review without an artificial repair deployment", async () => {
  const parts = await fixture();
  let record = await parts.catalog.create("case-planned-review", parts.plan.remediationPlanId);
  record = await parts.catalog.requireReview(record.caseId, "Operator paused remediation before execution.", record.revision);
  assert.equal(record.status, "review");
  assert.equal(record.repairDeploymentId, undefined);
});

test("deployment mutation across closure commit invalidates the case to review", async () => {
  const parts = await fixture(ClosureRaceDeploymentStore);
  const evidence = await prepareVerifyingCase(parts, "case-race");
  parts.deployments.arm();

  await assert.rejects(
    () => parts.catalog.close(
      evidence.record.caseId,
      evidence.baseline.baselineId,
      evidence.assessment.assessmentId,
      evidence.record.revision,
    ),
    /changed across closure commit|changed during closure/i,
  );

  const persisted = await parts.catalog.get(evidence.record.caseId);
  assert.equal(persisted.status, "review");
  assert.match(persisted.reviewReason, /closure/i);
  assert.ok(persisted.replacementBaselineId);
  assert.ok(persisted.closureAssessmentId);
});

test("stable repair deployment progresses through durable closing and remains closed", async () => {
  const parts = await fixture();
  const evidence = await prepareVerifyingCase(parts, "case-stable");
  const closed = await parts.catalog.close(
    evidence.record.caseId,
    evidence.baseline.baselineId,
    evidence.assessment.assessmentId,
    evidence.record.revision,
  );
  assert.equal(closed.status, "closed");
  assert.ok(closed.closedAt);
  assert.ok(closed.revision >= evidence.record.revision + 2);
});
