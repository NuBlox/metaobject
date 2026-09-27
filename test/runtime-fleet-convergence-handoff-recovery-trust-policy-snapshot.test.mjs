import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyBoundStore,
  MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotStore,
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyBoundCatalog,
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotCatalog,
  digestTrustPolicy,
} from "../dist/index.js";

const policy = {
  policyId: "dual-control",
  version: 1,
  minimumValidSignatures: 2,
  signers: [
    { signerId: "security", required: true, allowedAlgorithms: ["ALG"], allowedKeyIds: ["security-key"] },
    { signerId: "operations", allowedAlgorithms: ["ALG"], allowedKeyIds: ["operations-key"] },
  ],
};

class TrustSource {
  records = new Map();
  calls = 0;

  async get(evaluationId) {
    const record = this.records.get(evaluationId);
    return record ? structuredClone(record) : null;
  }

  async evaluate(request) {
    this.calls += 1;
    const record = {
      format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust",
      formatVersion: 1,
      evaluationId: request.evaluationId,
      integrityId: request.integrityId,
      policyId: request.policy.policyId,
      policyVersion: request.policy.version,
      decision: "trusted",
      minimumValidSignatures: request.policy.minimumValidSignatures,
      validSignerIds: ["operations", "security"],
      missingRequiredSignerIds: [],
      signatures: [],
      evaluatedAt: "2026-09-27T12:10:00.000Z",
    };
    this.records.set(record.evaluationId, structuredClone(record));
    return structuredClone(record);
  }
}

async function setup() {
  const snapshots = new MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotStore();
  const snapshotCatalog = new RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotCatalog(
    snapshots,
    () => new Date("2026-09-27T12:00:00.000Z"),
  );
  const snapshot = await snapshotCatalog.publish({ snapshotId: "policy-snapshot-1", policy });
  const trust = new TrustSource();
  const bindings = new MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyBoundStore();
  const catalog = new RuntimeFleetHandoffRecoveryEvidenceTrustPolicyBoundCatalog(
    snapshots,
    trust,
    bindings,
    () => new Date("2026-09-27T12:11:00.000Z"),
  );
  return { snapshots, snapshotCatalog, snapshot, trust, bindings, catalog };
}

test("publishes an immutable canonical policy snapshot and reserves policyId@version", async () => {
  const snapshots = new MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotStore();
  const catalog = new RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotCatalog(
    snapshots,
    () => new Date("2026-09-27T12:00:00.000Z"),
  );
  const mutable = structuredClone(policy);
  const published = await catalog.publish({ snapshotId: "snapshot-1", policy: mutable });
  mutable.signers[0].allowedKeyIds[0] = "mutated-key";

  assert.match(published.policyDigest, /^[0-9a-f]{64}$/);
  assert.equal(published.policy.signers[0].allowedKeyIds[0], "security-key");
  assert.equal(published.policyDigest, await digestTrustPolicy(policy));
  assert.equal((await catalog.resolve("dual-control", 1)).snapshotId, "snapshot-1");

  await assert.rejects(
    () => catalog.publish({
      snapshotId: "snapshot-redefinition",
      policy: { ...policy, minimumValidSignatures: 1 },
    }),
    /already published/i,
  );
});

test("policy-bound evaluation can only be created from the exact published snapshot", async () => {
  const { catalog, trust, snapshot } = await setup();
  const binding = await catalog.evaluate({
    bindingId: "binding-1",
    evaluationId: "evaluation-1",
    integrityId: "integrity-1",
    snapshotId: snapshot.snapshotId,
  });

  assert.equal(trust.calls, 1);
  assert.equal(binding.policyDigest, snapshot.policyDigest);
  assert.equal(binding.policyId, "dual-control");
  assert.equal(binding.policyVersion, 1);
  assert.equal(binding.decision, "trusted");
  assert.equal((await catalog.verify(binding.bindingId)).valid, true);
});

test("recovers after M51 persisted but before the M52 binding was written", async () => {
  const { catalog, trust, snapshot } = await setup();
  await trust.evaluate({ evaluationId: "evaluation-recovery", integrityId: "integrity-1", policy: snapshot.policy });
  const callsBefore = trust.calls;

  const binding = await catalog.evaluate({
    bindingId: "binding-recovery",
    evaluationId: "evaluation-recovery",
    integrityId: "integrity-1",
    snapshotId: snapshot.snapshotId,
  });

  assert.equal(trust.calls, callsBefore);
  assert.equal(binding.evaluationId, "evaluation-recovery");
  assert.equal((await catalog.verify(binding.bindingId)).valid, true);
});

test("rejects an existing M51 evaluation that was created under different policy semantics", async () => {
  const { catalog, trust, snapshot } = await setup();
  trust.records.set("evaluation-mismatch", {
    format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust",
    formatVersion: 1,
    evaluationId: "evaluation-mismatch",
    integrityId: "integrity-1",
    policyId: "dual-control",
    policyVersion: 1,
    decision: "trusted",
    minimumValidSignatures: 1,
    validSignerIds: ["security"],
    missingRequiredSignerIds: [],
    signatures: [],
    evaluatedAt: "2026-09-27T12:10:00.000Z",
  });

  await assert.rejects(
    () => catalog.evaluate({
      bindingId: "binding-mismatch",
      evaluationId: "evaluation-mismatch",
      integrityId: "integrity-1",
      snapshotId: snapshot.snapshotId,
    }),
    /does not match policy snapshot/i,
  );
});

test("verification detects a policy snapshot whose embedded policy no longer matches its digest", async () => {
  const { snapshots, catalog, trust, bindings, snapshot } = await setup();
  const binding = await catalog.evaluate({
    bindingId: "binding-tamper",
    evaluationId: "evaluation-tamper",
    integrityId: "integrity-1",
    snapshotId: snapshot.snapshotId,
  });

  const tamperedSnapshots = {
    async get(snapshotId) {
      const record = await snapshots.get(snapshotId);
      if (!record) return null;
      record.policy.minimumValidSignatures = 1;
      return record;
    },
    async getByIdentity(policyId, policyVersion) { return snapshots.getByIdentity(policyId, policyVersion); },
    async list(filter) { return snapshots.list(filter); },
    async create(record) { return snapshots.create(record); },
  };
  const verifier = new RuntimeFleetHandoffRecoveryEvidenceTrustPolicyBoundCatalog(
    tamperedSnapshots,
    trust,
    bindings,
    () => new Date("2026-09-27T12:12:00.000Z"),
  );

  const result = await verifier.verify(binding.bindingId);
  assert.equal(result.valid, false);
  assert.equal(result.policyDigestMatches, false);
  assert.equal(result.evaluationMatches, true);
});

test("bindings are idempotent for the same identity, create-only for different identity, detached and filterable", async () => {
  const { catalog, snapshot } = await setup();
  const request = {
    bindingId: "binding-history",
    evaluationId: "evaluation-history",
    integrityId: "integrity-1",
    snapshotId: snapshot.snapshotId,
  };
  const first = await catalog.evaluate(request);
  const again = await catalog.evaluate(request);
  assert.deepEqual(again, first);

  first.policyId = "mutated";
  assert.equal((await catalog.get("binding-history")).policyId, "dual-control");
  assert.equal((await catalog.history({ policyId: "dual-control", decision: "trusted" })).length, 1);

  await assert.rejects(
    () => catalog.evaluate({ ...request, evaluationId: "different-evaluation" }),
    /different identity/i,
  );
});
