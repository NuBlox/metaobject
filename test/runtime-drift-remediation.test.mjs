import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryRuntimeDeploymentDriftAssessmentStore,
  MemoryRuntimeDeploymentDriftBaselineStore,
  MemoryRuntimeDeploymentStore,
  MemoryRuntimeDriftRemediationPlanStore,
  RuntimeDeploymentCatalog,
  RuntimeDeploymentExecutorRegistry,
  RuntimeDeploymentRunner,
  RuntimeDriftClassifierRegistry,
  RuntimeDriftRemediationCatalog,
  RuntimeDriftRemediationHandlerRegistry,
  RuntimeDriftRemediationPlanProvider,
} from "../dist/index.js";

function completedDeployment(id = "deploy-source") {
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

async function fixture(check) {
  const deployments = new MemoryRuntimeDeploymentStore();
  const deployment = await deployments.save(completedDeployment());
  const baselines = new MemoryRuntimeDeploymentDriftBaselineStore();
  const baseline = await baselines.create({
    format: "nublox-metaobject-runtime-drift-baseline",
    formatVersion: 1,
    baselineId: "baseline-1",
    attestationId: "attestation-1",
    deploymentId: deployment.deploymentId,
    deploymentRevision: deployment.revision,
    deploymentCreatedAt: deployment.createdAt,
    profileId: deployment.profileId,
    profileVersion: deployment.toProfileVersion,
    fingerprints: [{ probeId: "schema", fingerprint: "schema:v2" }],
    createdAt: "2026-01-01T00:02:00.000Z",
  });
  const assessments = new MemoryRuntimeDeploymentDriftAssessmentStore();
  const assessment = await assessments.create({
    format: "nublox-metaobject-runtime-drift-assessment",
    formatVersion: 1,
    assessmentId: "assessment-1",
    baselineId: baseline.baselineId,
    deploymentId: deployment.deploymentId,
    deploymentRevision: deployment.revision,
    deploymentCreatedAt: deployment.createdAt,
    outcome: check.status === "changed" ? "drift" : "warning",
    checks: [check],
    createdAt: "2026-01-01T00:03:00.000Z",
  });
  const plans = new MemoryRuntimeDriftRemediationPlanStore();
  return { deployments, deployment, baselines, baseline, assessments, assessment, plans };
}

function planner(parts, classifiers, handlers) {
  return new RuntimeDriftRemediationCatalog(
    parts.deployments,
    parts.baselines,
    parts.assessments,
    parts.plans,
    classifiers,
    handlers,
    () => new Date("2026-01-01T00:04:00.000Z"),
  );
}

test("unauthorized drift becomes an executable M17/M18 remediation deployment", async () => {
  const parts = await fixture({
    probeId: "schema",
    status: "changed",
    baselineFingerprint: "schema:v2",
    currentFingerprint: "schema:hotfix",
  });
  const classifiers = new RuntimeDriftClassifierRegistry().register({
    probeId: "schema",
    classify: () => ({ classification: "unauthorized", message: "Out-of-band schema change." }),
  });
  const handlers = new RuntimeDriftRemediationHandlerRegistry().register({
    probeId: "schema",
    plan: () => [{
      kind: "migrate-object-type",
      moduleId: "core",
      objectTypeId: "core.settings",
      fromVersion: 2,
      toVersion: 2,
      blocking: false,
      requiresManualReview: false,
      description: "Restore the governed schema fingerprint.",
    }],
  });
  const remediation = planner(parts, classifiers, handlers);
  const plan = await remediation.plan("assessment-1", "remediation-1");
  assert.equal(plan.disposition, "remediate");
  assert.equal(plan.requiresManualReview, false);
  assert.equal(plan.executionPlan.fromProfileVersion, 2);
  assert.equal(plan.executionPlan.toProfileVersion, 2);
  assert.equal(plan.steps.length, 1);

  const provider = new RuntimeDriftRemediationPlanProvider(parts.plans, plan.remediationPlanId);
  const deploymentCatalog = new RuntimeDeploymentCatalog(
    parts.deployments,
    provider,
    () => new Date("2026-01-01T00:05:00.000Z"),
  );
  const repair = await deploymentCatalog.create("repair-deployment", "production", 2, 2);
  assert.equal(repair.plan.steps[0].kind, "migrate-object-type");

  const executors = new RuntimeDeploymentExecutorRegistry().register({
    id: "schema-remediator",
    kinds: ["migrate-object-type"],
    idempotency: "keyed",
    execute: () => ({ status: "completed", evidence: { externalReference: "migration:restore-v2" } }),
  });
  const runner = new RuntimeDeploymentRunner(
    deploymentCatalog,
    executors,
    () => new Date("2026-01-01T00:06:00.000Z"),
  );
  const result = await runner.run(repair.deploymentId);
  assert.equal(result.record.status, "completed");
  assert.equal(result.executedSteps, 1);
});

test("authorized drift is accepted but requires a new verified baseline", async () => {
  const parts = await fixture({
    probeId: "schema",
    status: "changed",
    baselineFingerprint: "schema:v2",
    currentFingerprint: "schema:approved-hotfix",
  });
  const remediation = planner(
    parts,
    new RuntimeDriftClassifierRegistry().register({
      probeId: "schema",
      classify: () => ({ classification: "authorized", message: "Approved emergency change CHG-42." }),
    }),
    new RuntimeDriftRemediationHandlerRegistry(),
  );
  const plan = await remediation.plan("assessment-1", "remediation-authorized");
  assert.equal(plan.disposition, "accepted");
  assert.equal(plan.requiresBaselineRefresh, true);
  assert.equal(plan.executionPlan, undefined);
  assert.equal(plan.decisions[0].action, "accept");
});

test("unclassified or unverifiable drift fails safe into manual review", async () => {
  const changed = await fixture({
    probeId: "schema",
    status: "changed",
    baselineFingerprint: "schema:v2",
    currentFingerprint: "schema:unknown",
  });
  const changedPlan = await planner(
    changed,
    new RuntimeDriftClassifierRegistry(),
    new RuntimeDriftRemediationHandlerRegistry(),
  ).plan("assessment-1", "remediation-review");
  assert.equal(changedPlan.disposition, "review");
  assert.equal(changedPlan.requiresManualReview, true);
  assert.equal(changedPlan.executionPlan, undefined);

  const warning = await fixture({
    probeId: "schema",
    status: "unverifiable",
    baselineFingerprint: "schema:v2",
    message: "Schema endpoint unavailable.",
  });
  const warningPlan = await planner(
    warning,
    new RuntimeDriftClassifierRegistry(),
    new RuntimeDriftRemediationHandlerRegistry(),
  ).plan("assessment-1", "remediation-warning");
  assert.equal(warningPlan.disposition, "review");
  assert.match(warningPlan.decisions[0].message, /endpoint unavailable/i);
});

test("remediation handler failures are durable review decisions rather than partial execution plans", async () => {
  const parts = await fixture({
    probeId: "schema",
    status: "changed",
    baselineFingerprint: "schema:v2",
    currentFingerprint: "schema:bad",
  });
  const remediation = planner(
    parts,
    new RuntimeDriftClassifierRegistry().register({
      probeId: "schema",
      classify: () => ({ classification: "unauthorized" }),
    }),
    new RuntimeDriftRemediationHandlerRegistry().register({
      probeId: "schema",
      plan: () => { throw new Error("cannot derive safe repair"); },
    }),
  );
  const plan = await remediation.plan("assessment-1", "remediation-handler-failed");
  assert.equal(plan.disposition, "review");
  assert.equal(plan.steps.length, 0);
  assert.match(plan.decisions[0].message, /cannot derive safe repair/i);
});
