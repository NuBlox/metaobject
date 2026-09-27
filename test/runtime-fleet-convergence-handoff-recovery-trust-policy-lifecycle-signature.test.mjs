import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureStore,
  RuntimeFleetHandoffRecoveryEvidenceSignatureProviderRegistry,
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureCatalog,
  lifecycleSignaturePayload,
} from "../dist/index.js";

function integrityRecord() {
  return {
    format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-integrity",
    formatVersion: 1,
    attestationId: "lifecycle-integrity-1",
    policyId: "dual-control",
    lifecycleRevision: 1,
    lifecycleStatus: "active",
    snapshotId: "snapshot-1",
    policyVersion: 1,
    algorithm: "SHA-256",
    canonicalization: "nublox-json-canonical-v1",
    events: [
      {
        eventId: "event-1",
        revision: 1,
        type: "activate",
        snapshotId: "snapshot-1",
        policyVersion: 1,
        digest: "a".repeat(64),
      },
    ],
    snapshots: [
      {
        snapshotId: "snapshot-1",
        policyVersion: 1,
        policyDigest: "b".repeat(64),
      },
    ],
    currentStateDigest: "c".repeat(64),
    rootDigest: "d".repeat(64),
    createdAt: "2026-09-27T12:30:00.000Z",
  };
}

function fixture({ integrityValid = true, providerThrows = false } = {}) {
  const current = integrityRecord();
  const source = {
    async get(id) { return id === current.attestationId ? structuredClone(current) : null; },
    async verify(id) {
      return {
        attestationId: id,
        valid: integrityValid,
        chainValid: integrityValid,
        eventsMatch: integrityValid,
        snapshotsMatch: integrityValid,
        currentStateMatches: integrityValid,
        rootDigestMatches: integrityValid,
        expectedRootDigest: current.rootDigest,
        actualRootDigest: current.rootDigest,
        verifiedAt: "2026-09-27T12:31:00.000Z",
      };
    },
  };
  const providers = new RuntimeFleetHandoffRecoveryEvidenceSignatureProviderRegistry();
  providers.register({
    signerId: "kms-policy-governance",
    async sign(payload) {
      return { algorithm: "TEST-SIGN-v1", keyId: "policy-key-2026-09", signature: `signed:${payload}` };
    },
    async verify(payload, material) {
      if (providerThrows) throw new Error("verifier unavailable");
      return material.algorithm === "TEST-SIGN-v1"
        && material.keyId === "policy-key-2026-09"
        && material.signature === `signed:${payload}`;
    },
  });
  const store = new MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureStore();
  const catalog = new RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureCatalog(
    source,
    providers,
    store,
    () => new Date("2026-09-27T12:32:00.000Z"),
  );
  return { catalog, store, source, current, providers };
}

test("signs and verifies the exact canonical M54 lifecycle integrity payload", async () => {
  const { catalog, current } = fixture();
  const record = await catalog.sign({
    signatureId: "lifecycle-signature-1",
    attestationId: current.attestationId,
    signerId: "kms-policy-governance",
  });

  assert.equal(record.attestationId, current.attestationId);
  assert.equal(record.policyId, "dual-control");
  assert.equal(record.lifecycleRevision, 1);
  assert.equal(record.rootDigest, current.rootDigest);
  assert.equal(record.signerId, "kms-policy-governance");
  assert.equal(record.algorithm, "TEST-SIGN-v1");
  assert.equal(record.keyId, "policy-key-2026-09");
  assert.equal(record.signature, `signed:${lifecycleSignaturePayload(current)}`);
  assert.match(record.payloadDigest, /^[0-9a-f]{64}$/);

  const verified = await catalog.verify(record.signatureId);
  assert.deepEqual(
    {
      valid: verified.valid,
      lifecycleIntegrityValid: verified.lifecycleIntegrityValid,
      payloadMatches: verified.payloadMatches,
      signatureValid: verified.signatureValid,
    },
    {
      valid: true,
      lifecycleIntegrityValid: true,
      payloadMatches: true,
      signatureValid: true,
    },
  );
});

test("refuses to sign lifecycle integrity that no longer verifies", async () => {
  const { catalog } = fixture({ integrityValid: false });
  await assert.rejects(
    () => catalog.sign({
      signatureId: "lifecycle-signature-invalid",
      attestationId: "lifecycle-integrity-1",
      signerId: "kms-policy-governance",
    }),
    /no longer valid and cannot be signed/i,
  );
});

test("verification detects a changed M54 root even when the replacement lifecycle is internally valid", async () => {
  const { catalog, current } = fixture();
  await catalog.sign({
    signatureId: "lifecycle-signature-1",
    attestationId: current.attestationId,
    signerId: "kms-policy-governance",
  });
  current.rootDigest = "e".repeat(64);

  const verified = await catalog.verify("lifecycle-signature-1");
  assert.equal(verified.valid, false);
  assert.equal(verified.lifecycleIntegrityValid, true);
  assert.equal(verified.payloadMatches, false);
  assert.equal(verified.signatureValid, false);
});

test("provider verification errors fail closed", async () => {
  const { catalog } = fixture({ providerThrows: true });
  await catalog.sign({
    signatureId: "lifecycle-signature-1",
    attestationId: "lifecycle-integrity-1",
    signerId: "kms-policy-governance",
  });

  const verified = await catalog.verify("lifecycle-signature-1");
  assert.equal(verified.valid, false);
  assert.equal(verified.lifecycleIntegrityValid, true);
  assert.equal(verified.payloadMatches, true);
  assert.equal(verified.signatureValid, false);
});

test("lifecycle signature history is create-only, detached and filterable", async () => {
  const { catalog } = fixture();
  const record = await catalog.sign({
    signatureId: "lifecycle-signature-history",
    attestationId: "lifecycle-integrity-1",
    signerId: "kms-policy-governance",
  });

  record.signature = "mutated";
  assert.notEqual((await catalog.get("lifecycle-signature-history")).signature, "mutated");
  assert.equal((await catalog.history({ policyId: "dual-control" })).length, 1);
  assert.equal((await catalog.history({ signerId: "kms-policy-governance" })).length, 1);
  assert.equal((await catalog.history({ keyId: "other" })).length, 0);
  await assert.rejects(
    () => catalog.sign({
      signatureId: "lifecycle-signature-history",
      attestationId: "lifecycle-integrity-1",
      signerId: "kms-policy-governance",
    }),
    /already exists/i,
  );
});
