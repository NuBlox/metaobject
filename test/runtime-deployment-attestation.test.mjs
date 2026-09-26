import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryRuntimeDeploymentAttestationStore,
  MemoryRuntimeDeploymentStore,
  RuntimeDeploymentAttestationCatalog,
  RuntimeDeploymentVerifierRegistry,
} from "../dist/index.js";

function completedDeployment(id = "deploy-1") {
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
    startedAt: "2026-01-01T00:00:30.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
  };
}

async function fixture(verifiers) {
  const deployments = new MemoryRuntimeDeploymentStore();
  const stored = await deployments.save(completedDeployment());
  const attestations = new MemoryRuntimeDeploymentAttestationStore();
  const registry = new RuntimeDeploymentVerifierRegistry();
  for (const verifier of verifiers) registry.register(verifier);
  const catalog = new RuntimeDeploymentAttestationCatalog(
    deployments,
    attestations,
    registry,
    () => new Date("2026-01-01T00:02:00.000Z"),
  );
  return { deployments, attestations, registry, catalog, stored };
}

test("attestation aggregates ordered verifier results and binds exact deployment revision", async () => {
  const { catalog, stored } = await fixture([
    { id: "schema", verify: () => ({ outcome: "pass", evidence: { recordedAt: "2026-01-01T00:01:30.000Z", externalReference: "schema:2" } }) },
    { id: "health", verify: () => ({ outcome: "warn", message: "Replica lag remains elevated." }) },
  ]);

  const attestation = await catalog.verify("deploy-1", "att-1");
  assert.equal(attestation.outcome, "warn");
  assert.equal(attestation.deploymentRevision, stored.revision);
  assert.equal(attestation.toProfileVersion, 2);
  assert.equal(attestation.journalSequence, 2);
  assert.deepEqual(attestation.checks.map((check) => check.verifierId), ["schema", "health"]);
});

test("verifier exceptions fail closed without suppressing later checks", async () => {
  const { catalog } = await fixture([
    { id: "external", verify: () => { throw new Error("endpoint unavailable"); } },
    { id: "schema", verify: () => ({ outcome: "pass" }) },
  ]);
  const attestation = await catalog.verify("deploy-1", "att-fail");
  assert.equal(attestation.outcome, "fail");
  assert.match(attestation.checks[0].message, /failed closed.*endpoint unavailable/i);
  assert.equal(attestation.checks[1].outcome, "pass");
});

test("attestations are immutable and returned values are detached", async () => {
  const { catalog } = await fixture([{ id: "schema", verify: () => ({ outcome: "pass" }) }]);
  const first = await catalog.verify("deploy-1", "att-once");
  first.checks[0].message = "mutated locally";
  const persisted = await catalog.get("att-once");
  assert.equal(persisted.checks[0].message, undefined);
  await assert.rejects(() => catalog.verify("deploy-1", "att-once"), /already exists/i);
});

test("non-completed deployments cannot be attested", async () => {
  const deployments = new MemoryRuntimeDeploymentStore();
  await deployments.save({ ...completedDeployment("deploy-running"), status: "running", completedAt: undefined, steps: [] });
  const catalog = new RuntimeDeploymentAttestationCatalog(
    deployments,
    new MemoryRuntimeDeploymentAttestationStore(),
    new RuntimeDeploymentVerifierRegistry().register({ id: "schema", verify: () => ({ outcome: "pass" }) }),
  );
  await assert.rejects(() => catalog.verify("deploy-running", "att-running"), /must be completed/i);
});

test("deployment mutation during verification prevents attestation creation", async () => {
  const deployments = new MemoryRuntimeDeploymentStore();
  const stored = await deployments.save(completedDeployment("deploy-race"));
  const registry = new RuntimeDeploymentVerifierRegistry().register({
    id: "racing-check",
    verify: async () => {
      const current = await deployments.get("deploy-race");
      await deployments.save({ ...current, updatedAt: "2026-01-01T00:03:00.000Z" }, current.revision);
      return { outcome: "pass" };
    },
  });
  const attestationStore = new MemoryRuntimeDeploymentAttestationStore();
  const catalog = new RuntimeDeploymentAttestationCatalog(deployments, attestationStore, registry);
  await assert.rejects(() => catalog.verify("deploy-race", "att-race"), /changed during attestation/i);
  assert.equal((await attestationStore.list()).length, 0);
  assert.equal((await deployments.get("deploy-race")).revision, stored.revision + 1);
});
