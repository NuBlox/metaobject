import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyBoundStore,
  MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleStore,
  MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityStore,
  MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureStore,
  MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustEvaluationStore,
  MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleStore,
  MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotStore,
  RuntimeFleetHandoffRecoveryEvidenceSignatureProviderRegistry,
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleCatalog,
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleCatalog,
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityCatalog,
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureCatalog,
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustCatalog,
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotCatalog,
  verifyRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundle,
} from "../dist/index.js";

function signer(signerId, keyId) {
  return {
    signerId,
    async sign(payload) {
      return { algorithm: "TEST-SIGN-v1", keyId, signature: `${signerId}:${keyId}:${payload}` };
    },
    async verify(payload, material) {
      return material.algorithm === "TEST-SIGN-v1"
        && material.keyId === keyId
        && material.signature === `${signerId}:${keyId}:${payload}`;
    },
  };
}

async function fixture({ twoSignatures = true } = {}) {
  const snapshotStore = new MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotStore();
  const snapshotCatalog = new RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotCatalog(
    snapshotStore,
    () => new Date("2026-09-27T13:00:00.000Z"),
  );
  const recoveryPolicyV1 = {
    policyId: "recovery-evidence-trust",
    version: 1,
    minimumValidSignatures: 1,
    signers: [{ signerId: "recovery-security", required: true }],
  };
  const snapshotV1 = await snapshotCatalog.publish({ snapshotId: "snapshot-v1", policy: recoveryPolicyV1 });

  const lifecycleStore = new MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleStore();
  const lifecycleCatalog = new RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleCatalog(
    snapshotStore,
    lifecycleStore,
    { async evaluate() { throw new Error("not used in this fixture"); } },
    () => new Date("2026-09-27T13:01:00.000Z"),
  );
  await lifecycleCatalog.activate({
    eventId: "activate-v1",
    snapshotId: snapshotV1.snapshotId,
    expectedRevision: 0,
    actorId: "security-admin",
    reason: "initial policy",
  });

  const integrityStore = new MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityStore();
  const integrityCatalog = new RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityCatalog(
    lifecycleStore,
    snapshotStore,
    integrityStore,
    () => new Date("2026-09-27T13:02:00.000Z"),
  );
  const integrity = await integrityCatalog.create({
    attestationId: "lifecycle-integrity-v1",
    policyId: recoveryPolicyV1.policyId,
  });

  const providers = new RuntimeFleetHandoffRecoveryEvidenceSignatureProviderRegistry();
  providers.register(signer("security", "security-key"));
  providers.register(signer("operations", "operations-key"));

  const signatureStore = new MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureStore();
  const signatureCatalog = new RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureCatalog(
    integrityCatalog,
    providers,
    signatureStore,
    () => new Date("2026-09-27T13:03:00.000Z"),
  );
  await signatureCatalog.sign({
    signatureId: "sig-security",
    attestationId: integrity.attestationId,
    signerId: "security",
  });
  if (twoSignatures) {
    await signatureCatalog.sign({
      signatureId: "sig-operations",
      attestationId: integrity.attestationId,
      signerId: "operations",
    });
  }

  const trustPolicy = {
    policyId: "lifecycle-governance-trust",
    version: 1,
    minimumValidSignatures: 2,
    signers: [
      {
        signerId: "security",
        required: true,
        allowedAlgorithms: ["TEST-SIGN-v1"],
        allowedKeyIds: ["security-key"],
      },
      {
        signerId: "operations",
        allowedAlgorithms: ["TEST-SIGN-v1"],
        allowedKeyIds: ["operations-key"],
      },
    ],
  };
  const evaluationStore = new MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustEvaluationStore();
  const evaluationCatalog = new RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustCatalog(
    signatureCatalog,
    evaluationStore,
    () => new Date("2026-09-27T13:04:00.000Z"),
  );
  const evaluation = await evaluationCatalog.evaluate({
    evaluationId: "lifecycle-trust-eval-v1",
    attestationId: integrity.attestationId,
    policy: trustPolicy,
  });

  const bundleStore = new MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleStore();
  const bundleCatalog = new RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleCatalog(
    lifecycleStore,
    snapshotStore,
    integrityCatalog,
    signatureCatalog,
    evaluationCatalog,
    providers,
    bundleStore,
    () => new Date("2026-09-27T13:05:00.000Z"),
  );

  return {
    snapshotStore,
    snapshotCatalog,
    lifecycleStore,
    lifecycleCatalog,
    integrityCatalog,
    signatureCatalog,
    evaluationCatalog,
    providers,
    bundleStore,
    bundleCatalog,
    integrity,
    trustPolicy,
    evaluation,
  };
}

test("creates a portable bundle and reproduces the complete trusted M54-M56 chain offline", async () => {
  const f = await fixture();
  const bundle = await f.bundleCatalog.create({
    bundleId: "bundle-v1",
    attestationId: f.integrity.attestationId,
    evaluationId: f.evaluation.evaluationId,
    trustPolicy: f.trustPolicy,
  });

  assert.equal(bundle.trustEvaluation.decision, "trusted");
  assert.equal(bundle.lifecycleEvents.length, 1);
  assert.equal(bundle.policySnapshots.length, 1);
  assert.equal(bundle.lifecycleSignatures.length, 2);
  assert.match(bundle.rootDigest, /^[0-9a-f]{64}$/);
  for (const digest of Object.values(bundle.componentDigests)) assert.match(digest, /^[0-9a-f]{64}$/);

  const verified = await f.bundleCatalog.verify(bundle.bundleId);
  assert.deepEqual(
    {
      valid: verified.valid,
      componentDigestsMatch: verified.componentDigestsMatch,
      rootDigestMatches: verified.rootDigestMatches,
      lifecycleIntegrityValid: verified.lifecycleIntegrityValid,
      trustEvaluationMatches: verified.trustEvaluationMatches,
      trustDecision: verified.trustDecision,
    },
    {
      valid: true,
      componentDigestsMatch: true,
      rootDigestMatches: true,
      lifecycleIntegrityValid: true,
      trustEvaluationMatches: true,
      trustDecision: "trusted",
    },
  );
});

test("exports and verifies historical lifecycle evidence after the live M53 policy advances", async () => {
  const f = await fixture();

  const recoveryPolicyV2 = {
    policyId: "recovery-evidence-trust",
    version: 2,
    minimumValidSignatures: 1,
    signers: [{ signerId: "recovery-security", required: true }],
  };
  const snapshotV2 = await f.snapshotCatalog.publish({ snapshotId: "snapshot-v2", policy: recoveryPolicyV2 });
  await f.lifecycleCatalog.activate({
    eventId: "activate-v2",
    snapshotId: snapshotV2.snapshotId,
    expectedRevision: 1,
    actorId: "security-admin",
    reason: "policy rotation",
  });

  assert.equal((await f.integrityCatalog.verify(f.integrity.attestationId)).valid, false);

  const bundle = await f.bundleCatalog.create({
    bundleId: "historical-bundle-v1",
    attestationId: f.integrity.attestationId,
    evaluationId: f.evaluation.evaluationId,
    trustPolicy: f.trustPolicy,
  });
  assert.equal(bundle.lifecycleRevision, 1);
  assert.equal(bundle.lifecycleEvents.length, 1);
  assert.equal(bundle.lifecycleState.snapshotId, "snapshot-v1");
  assert.equal((await f.bundleCatalog.verify(bundle.bundleId)).valid, true);
});

test("a structurally valid policy mutation breaks component integrity and reproduced M56 trust", async () => {
  const f = await fixture();
  const bundle = await f.bundleCatalog.create({
    bundleId: "bundle-policy-tamper",
    attestationId: f.integrity.attestationId,
    evaluationId: f.evaluation.evaluationId,
    trustPolicy: f.trustPolicy,
  });
  bundle.trustPolicy.signers[0].allowedKeyIds[0] = "different-key";

  const verified = await verifyRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundle(
    bundle,
    f.providers,
    () => new Date("2026-09-27T13:06:00.000Z"),
  );
  assert.equal(verified.valid, false);
  assert.equal(verified.componentDigestsMatch, false);
  assert.equal(verified.rootDigestMatches, false);
  assert.equal(verified.lifecycleIntegrityValid, true);
  assert.equal(verified.trustEvaluationMatches, false);
});

test("signature tampering is detected by the bundle digest and offline M55/M56 replay", async () => {
  const f = await fixture();
  const bundle = await f.bundleCatalog.create({
    bundleId: "bundle-signature-tamper",
    attestationId: f.integrity.attestationId,
    evaluationId: f.evaluation.evaluationId,
    trustPolicy: f.trustPolicy,
  });
  bundle.lifecycleSignatures[0].signature = "tampered-signature";

  const verified = await verifyRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundle(bundle, f.providers);
  assert.equal(verified.valid, false);
  assert.equal(verified.componentDigestsMatch, false);
  assert.equal(verified.trustEvaluationMatches, false);
});

test("an internally consistent untrusted M56 decision is still a valid portable evidence bundle", async () => {
  const f = await fixture({ twoSignatures: false });
  assert.equal(f.evaluation.decision, "untrusted");

  const bundle = await f.bundleCatalog.create({
    bundleId: "bundle-untrusted",
    attestationId: f.integrity.attestationId,
    evaluationId: f.evaluation.evaluationId,
    trustPolicy: f.trustPolicy,
  });
  const verified = await f.bundleCatalog.verify(bundle.bundleId);
  assert.equal(verified.valid, true);
  assert.equal(verified.trustDecision, "untrusted");
});

test("bundle history is create-only, detached and filterable", async () => {
  const f = await fixture();
  const bundle = await f.bundleCatalog.create({
    bundleId: "bundle-history",
    attestationId: f.integrity.attestationId,
    evaluationId: f.evaluation.evaluationId,
    trustPolicy: f.trustPolicy,
  });
  bundle.lifecycleState.snapshotId = "mutated";
  assert.equal((await f.bundleCatalog.get("bundle-history")).lifecycleState.snapshotId, "snapshot-v1");
  assert.equal((await f.bundleCatalog.history({ policyId: "recovery-evidence-trust" })).length, 1);
  assert.equal((await f.bundleCatalog.history({ decision: "untrusted" })).length, 0);
  await assert.rejects(
    () => f.bundleCatalog.create({
      bundleId: "bundle-history",
      attestationId: f.integrity.attestationId,
      evaluationId: f.evaluation.evaluationId,
      trustPolicy: f.trustPolicy,
    }),
    /already exists/i,
  );
});
