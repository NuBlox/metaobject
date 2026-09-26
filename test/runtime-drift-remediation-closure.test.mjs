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

function executionPlan(remediationPlanId = "remediation-1") {
  return {
    format: "nublox-metaobject-runtime-profile-upgrade",
    formatVersion: 1,
    remediationPlanId,
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
      description: "Restore governed schema state.",
    }],
  };
}

function remediationPlan(id = "remediation-1") {
  const plan = executionPlan(id);
  return {
    format: "nublox-metaobject-runtime-drift-remediation",
    formatVersion: 1,
    remediationPlanId: id,
    assessmentId: "assessment-source",
    baselineId: "baseline-source",
    deploymentId: "source-deployment",
    deploymentRevision: 4,
    profileId: "production",
    profileVersion: 2,
    disposition: "remediate",
    requiresManualReview: false,
    requiresBaselineRefresh: false,
    decisions: [{
      probeId: "schema",
      checkStatus: "changed",
      classification: "unauthorized",
      action: "remediate",
      message: "Out-of-band schema change.",
      stepIds: [plan.steps[0].id],
    }],
    steps: plan.steps,
    executionPlan: plan,
    createdAt: "2026-01-01T00:04:00.000Z",
  };
}

function repairDeployment(plan, id = "repair-1") {
  return {
    deploymentId: id,
    status: "completed",
    revision: 0,
    profileId: "production",
    fromProfileVersion: 2,
    toProfileVersion: 2,
    plan,
    steps: [{
      stepId: plan.steps[0].id,
      status: "completed",
      attempts: 1,
      executorId: "schema-remediator",
      idempotencyKey: `${id}:${plan.steps[0].id}`,
      startedAt: "2026-01-01T00:05:00.000Z",
      completedAt: "2026-01-01T00:06:00.000Z",
    }],
    journal: [
      { sequence: 1, kind: "deployment-created", occurredAt: "2026-01-01T00:04:30.000Z" },
      { sequence: 2, kind: "deployment-started", occurredAt: "2026-01-01T00:05:00.000Z" },
      { sequence: 3, kind: "step-leased", occurredAt: "2026-01-01T00:05:00.000Z", stepId: plan.steps[0].id, attempt: 1 },
      { sequence: 4, kind: "step-completed", occurredAt: "2026-01-01T00:06:00.000Z", stepId: plan.steps[0].id, attempt: 1 },
      { sequence: 5, kind: "deployment-completed", occurredAt: "2026-01-01T00:06:00.000Z" },
    ],
    createdAt: "2026-01-01T00:04:30.000Z",
    updatedAt: "2026-01-01T00:06:00.000Z",
    startedAt: "2026-01-01T00:05:00.000Z",
    completedAt: "2026-01-01T00:06:00.000Z",
  };
}

async function fixture() {
  const plans = new MemoryRuntimeDriftRemediationPlanStore();
  const plan = await plans.create(remediationPlan());
  const deployments = new MemoryRuntimeDeploymentStore();
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

async function addPassingEvidence(parts, suffix = "1") {
  const attestation = await parts.attestations.create({
    format: "nublox-metaobject-runtime-deployment-attestation",
    formatVersion: 1,
    attestationId: `att-repair-${suffix}`,
    deploymentId: parts.repair.deploymentId,
    deploymentRevision: parts.repair.revision,
    deploymentCreatedAt: parts.repair.createdAt,
    profileId: "production",
    fromProfileVersion: 2,
    toProfileVersion: 2,
    outcome: "pass",
    checks: [{ verifierId: "schema", outcome: "pass" }],
    journalSequence: 5,
    createdAt: "2026-01-01T00:07:00.000Z",
  });
  const baseline = await parts.baselines.create({
    format: "nublox-metaobject-runtime-drift-baseline",
    formatVersion: 1,
    baselineId: `baseline-repair-${suffix}`,
    attestationId: attestation.attestationId,
    deploymentId: parts.repair.deploymentId,
    deploymentRevision: parts.repair.revision,
    deploymentCreatedAt: parts.repair.createdAt,
    profileId: "production",
    profileVersion: 2,
    fingerprints: [{ probeId: "schema", fingerprint: "schema:restored" }],
    createdAt: "2026-01-01T00:08:00.000Z",
  });
  const assessment = await parts.assessments.create({
    format: "nublox-metaobject-runtime-drift-assessment",
    formatVersion: 1,
    assessmentId: `assessment-repair-${suffix}`,
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
    createdAt: "2026-01-01T00:09:00.000Z",
  });
  return { attestation, baseline, assessment };
}

test("case closes only after exact repair deployment, passing attestation, replacement baseline and clean assessment", async () => {
  const parts = await fixture();
  let record = await parts.catalog.create("case-1", parts.plan.remediationPlanId);
  assert.equal(record.status, "planned");
  record = await parts.catalog.linkDeployment(record.caseId, parts.repair.deploymentId, record.revision);
  assert.equal(record.status, "deploying");

  const evidence = await addPassingEvidence(parts);
  record = await parts.catalog.linkAttestation(record.caseId, evidence.attestation.attestationId, record.revision);
  assert.equal(record.status, "verifying");
  record = await parts.catalog.close(
    record.caseId,
    evidence.baseline.baselineId,
    evidence.assessment.assessmentId,
    record.revision,
  );
  assert.equal(record.status, "closed");
  assert.equal(record.replacementBaselineId, evidence.baseline.baselineId);
  assert.equal(record.closureAssessmentId, evidence.assessment.assessmentId);
  assert.ok(record.closedAt);
});

test("repair deployment must contain the exact immutable M24 execution plan", async () => {
  const parts = await fixture();
  const wrongPlan = structuredClone(parts.plan.executionPlan);
  wrongPlan.steps[0].description = "Different repair.";
  const wrong = await parts.deployments.save(repairDeployment(wrongPlan, "repair-wrong"));
  const record = await parts.catalog.create("case-wrong", parts.plan.remediationPlanId);
  await assert.rejects(
    () => parts.catalog.linkDeployment(record.caseId, wrong.deploymentId, record.revision),
    /exact immutable M24 execution plan/i,
  );
});

test("warning post-remediation attestation moves the case to review instead of allowing closure", async () => {
  const parts = await fixture();
  let record = await parts.catalog.create("case-warn", parts.plan.remediationPlanId);
  record = await parts.catalog.linkDeployment(record.caseId, parts.repair.deploymentId, record.revision);
  const warning = await parts.attestations.create({
    format: "nublox-metaobject-runtime-deployment-attestation",
    formatVersion: 1,
    attestationId: "att-warning",
    deploymentId: parts.repair.deploymentId,
    deploymentRevision: parts.repair.revision,
    deploymentCreatedAt: parts.repair.createdAt,
    profileId: "production",
    fromProfileVersion: 2,
    toProfileVersion: 2,
    outcome: "warn",
    checks: [{ verifierId: "health", outcome: "warn", message: "Health check degraded." }],
    journalSequence: 5,
    createdAt: "2026-01-01T00:07:00.000Z",
  });
  record = await parts.catalog.linkAttestation(record.caseId, warning.attestationId, record.revision);
  assert.equal(record.status, "review");
  assert.match(record.reviewReason, /does not prove restoration/i);
});

test("closure rejects baseline or assessment not bound to the verified repair deployment", async () => {
  const parts = await fixture();
  let record = await parts.catalog.create("case-mismatch", parts.plan.remediationPlanId);
  record = await parts.catalog.linkDeployment(record.caseId, parts.repair.deploymentId, record.revision);
  const evidence = await addPassingEvidence(parts, "mismatch");
  record = await parts.catalog.linkAttestation(record.caseId, evidence.attestation.attestationId, record.revision);

  const badBaseline = await parts.baselines.create({
    ...evidence.baseline,
    baselineId: "baseline-wrong-deployment",
    deploymentId: "other-deployment",
  });
  await assert.rejects(
    () => parts.catalog.close(record.caseId, badBaseline.baselineId, evidence.assessment.assessmentId, record.revision),
    /not bound to the verified repair deployment/i,
  );

  await assert.rejects(
    () => parts.catalog.close(record.caseId, evidence.baseline.baselineId, "missing-assessment", record.revision),
    /unknown remediation closure assessment/i,
  );
});

test("closure requires a clean immediate assessment and unchanged deployment snapshot", async () => {
  const parts = await fixture();
  let record = await parts.catalog.create("case-drifted", parts.plan.remediationPlanId);
  record = await parts.catalog.linkDeployment(record.caseId, parts.repair.deploymentId, record.revision);
  const evidence = await addPassingEvidence(parts, "drifted");
  record = await parts.catalog.linkAttestation(record.caseId, evidence.attestation.attestationId, record.revision);

  const dirty = await parts.assessments.create({
    ...evidence.assessment,
    assessmentId: "assessment-not-clean",
    outcome: "drift",
    checks: [{
      probeId: "schema",
      status: "changed",
      baselineFingerprint: "schema:restored",
      currentFingerprint: "schema:changed-again",
    }],
  });
  await assert.rejects(
    () => parts.catalog.close(record.caseId, evidence.baseline.baselineId, dirty.assessmentId, record.revision),
    /assesses cleanly/i,
  );

  await parts.deployments.save({ ...parts.repair, updatedAt: "2026-01-01T00:11:00.000Z" }, parts.repair.revision);
  await assert.rejects(
    () => parts.catalog.close(record.caseId, evidence.baseline.baselineId, evidence.assessment.assessmentId, record.revision),
    /exact repair deployment snapshot|verified repair deployment|closure assessment/i,
  );
});

test("case store enforces optimistic concurrency and closed-case immutability", async () => {
  const parts = await fixture();
  let record = await parts.catalog.create("case-concurrency", parts.plan.remediationPlanId);
  const staleRevision = record.revision;
  record = await parts.catalog.linkDeployment(record.caseId, parts.repair.deploymentId, record.revision);
  await assert.rejects(
    () => parts.catalog.requireReview(record.caseId, "stale writer", staleRevision),
    /concurrency conflict/i,
  );

  const evidence = await addPassingEvidence(parts, "concurrency");
  record = await parts.catalog.linkAttestation(record.caseId, evidence.attestation.attestationId, record.revision);
  record = await parts.catalog.close(record.caseId, evidence.baseline.baselineId, evidence.assessment.assessmentId, record.revision);
  await assert.rejects(
    () => parts.catalog.requireReview(record.caseId, "cannot reopen", record.revision),
    /closed.*cannot enter review/i,
  );
});
