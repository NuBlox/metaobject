import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryRuntimeDeploymentAttestationStore,
  MemoryRuntimeDeploymentDriftAssessmentStore,
  MemoryRuntimeDeploymentDriftBaselineStore,
  MemoryRuntimeDeploymentStore,
  RuntimeDeploymentAttestationCatalog,
  RuntimeDeploymentDriftCatalog,
  RuntimeDeploymentDriftProbeRegistry,
  RuntimeDeploymentPolicyRegistry,
  RuntimeDeploymentVerifierRegistry,
  validateRuntimeDeploymentJournal,
} from "../dist/index.js";

function completedDeployment(id = "deploy-hardening", createdAt = "2026-01-01T00:00:00.000Z") {
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
      { sequence: 1, kind: "deployment-created", occurredAt: createdAt },
      { sequence: 2, kind: "deployment-completed", occurredAt: "2026-01-01T00:01:00.000Z" },
    ],
    createdAt,
    updatedAt: "2026-01-01T00:01:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
  };
}

test("malformed policy evidence fails closed and trusted policy id cannot be replaced", async () => {
  const deployment = completedDeployment();
  const policies = new RuntimeDeploymentPolicyRegistry().register({
    id: "trusted-policy",
    evaluate: () => ({ outcome: "allow", policyId: "spoofed", evidence: null }),
  });
  const report = await policies.evaluate(deployment);
  assert.equal(report.allowed, false);
  assert.equal(report.evaluations[0].policyId, "trusted-policy");
  assert.equal(report.evaluations[0].outcome, "deny");
  assert.match(report.evaluations[0].message, /evidence must be an object/i);
});

test("journal validation rejects unsupported policy outcomes and malformed evidence", () => {
  assert.throws(() => validateRuntimeDeploymentJournal({
    deploymentId: "deploy-policy",
    journal: [{
      sequence: 1,
      kind: "deployment-policy-evaluated",
      occurredAt: "2026-01-01T00:00:00.000Z",
      policyId: "policy",
      policyOutcome: "permit",
      message: "not a supported outcome",
    }],
  }), /invalid policyOutcome/i);

  assert.throws(() => validateRuntimeDeploymentJournal({
    deploymentId: "deploy-evidence",
    journal: [{
      sequence: 1,
      kind: "step-completed",
      occurredAt: "2026-01-01T00:00:00.000Z",
      stepId: "step-1",
      attempt: 1,
      evidence: null,
    }],
  }), /evidence must be an object/i);
});

test("verifier results cannot spoof the trusted registry verifier id", async () => {
  const deployments = new MemoryRuntimeDeploymentStore();
  await deployments.save(completedDeployment("deploy-verifier"));
  const catalog = new RuntimeDeploymentAttestationCatalog(
    deployments,
    new MemoryRuntimeDeploymentAttestationStore(),
    new RuntimeDeploymentVerifierRegistry().register({
      id: "trusted-verifier",
      verify: () => ({ outcome: "pass", verifierId: "spoofed-verifier" }),
    }),
  );
  const attestation = await catalog.verify("deploy-verifier", "att-verifier");
  assert.equal(attestation.checks[0].verifierId, "trusted-verifier");
});

test("delete and recreate during attestation is detected even when revision number is reused", async () => {
  const deployments = new MemoryRuntimeDeploymentStore();
  await deployments.save(completedDeployment("deploy-recreate", "2026-01-01T00:00:00.000Z"));
  const attestations = new MemoryRuntimeDeploymentAttestationStore();
  const catalog = new RuntimeDeploymentAttestationCatalog(
    deployments,
    attestations,
    new RuntimeDeploymentVerifierRegistry().register({
      id: "race",
      verify: async () => {
        const current = await deployments.get("deploy-recreate");
        await deployments.delete("deploy-recreate", current.revision);
        await deployments.save(completedDeployment("deploy-recreate", "2026-01-01T00:10:00.000Z"));
        return { outcome: "pass" };
      },
    }),
  );
  await assert.rejects(() => catalog.verify("deploy-recreate", "att-recreate"), /changed during attestation/i);
  assert.equal((await attestations.list()).length, 0);
});

async function driftFixture() {
  const deployments = new MemoryRuntimeDeploymentStore();
  const deployment = await deployments.save(completedDeployment("deploy-drift-hardening"));
  const attestations = new MemoryRuntimeDeploymentAttestationStore();
  await attestations.create({
    format: "nublox-metaobject-runtime-deployment-attestation",
    formatVersion: 1,
    attestationId: "att-drift-hardening",
    deploymentId: deployment.deploymentId,
    deploymentRevision: deployment.revision,
    deploymentCreatedAt: deployment.createdAt,
    profileId: deployment.profileId,
    fromProfileVersion: deployment.fromProfileVersion,
    toProfileVersion: deployment.toProfileVersion,
    outcome: "pass",
    checks: [{ verifierId: "schema", outcome: "pass" }],
    journalSequence: 2,
    createdAt: "2026-01-01T00:02:00.000Z",
  });
  return { deployments, deployment, attestations };
}

test("deployment mutation during baseline probing rejects immutable baseline creation", async () => {
  const parts = await driftFixture();
  const baselines = new MemoryRuntimeDeploymentDriftBaselineStore();
  const drift = new RuntimeDeploymentDriftCatalog(
    parts.deployments,
    parts.attestations,
    baselines,
    new MemoryRuntimeDeploymentDriftAssessmentStore(),
    new RuntimeDeploymentDriftProbeRegistry().register({
      id: "schema",
      inspect: async () => {
        const current = await parts.deployments.get(parts.deployment.deploymentId);
        await parts.deployments.save({ ...current, updatedAt: "2026-01-01T00:04:00.000Z" }, current.revision);
        return { fingerprint: "schema:v2" };
      },
    }),
  );
  await assert.rejects(
    () => drift.createBaseline("att-drift-hardening", "baseline-race"),
    /changed during drift baseline inspection/i,
  );
  assert.equal(await baselines.get("baseline-race"), null);
});

test("deployment mutation during assessment probing rejects stale assessment creation", async () => {
  const parts = await driftFixture();
  const baselines = new MemoryRuntimeDeploymentDriftBaselineStore();
  const assessments = new MemoryRuntimeDeploymentDriftAssessmentStore();
  let mutate = false;
  const probes = new RuntimeDeploymentDriftProbeRegistry().register({
    id: "schema",
    inspect: async () => {
      if (mutate) {
        const current = await parts.deployments.get(parts.deployment.deploymentId);
        await parts.deployments.save({ ...current, updatedAt: "2026-01-01T00:05:00.000Z" }, current.revision);
      }
      return { fingerprint: "schema:v2" };
    },
  });
  const drift = new RuntimeDeploymentDriftCatalog(
    parts.deployments,
    parts.attestations,
    baselines,
    assessments,
    probes,
  );
  await drift.createBaseline("att-drift-hardening", "baseline-assessment-race");
  mutate = true;
  await assert.rejects(
    () => drift.assess("baseline-assessment-race", "assessment-race"),
    /changed during drift assessment/i,
  );
  assert.equal(await assessments.get("assessment-race"), null);
});

test("empty drift assessments cannot be persisted as clean evidence", async () => {
  const assessments = new MemoryRuntimeDeploymentDriftAssessmentStore();
  await assert.rejects(() => assessments.create({
    format: "nublox-metaobject-runtime-drift-assessment",
    formatVersion: 1,
    assessmentId: "empty-clean",
    baselineId: "baseline",
    deploymentId: "deployment",
    deploymentRevision: 1,
    outcome: "clean",
    checks: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  }), /requires at least one check/i);
});
