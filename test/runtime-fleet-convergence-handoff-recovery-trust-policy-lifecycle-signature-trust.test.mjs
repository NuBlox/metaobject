import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustEvaluationStore,
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustCatalog,
  validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustPolicy,
} from "../dist/index.js";

function signatureRecord({
  signatureId,
  signerId,
  algorithm = "TEST-SIGN-v1",
  keyId = `${signerId}-key`,
  attestationId = "lifecycle-integrity-1",
}) {
  return {
    format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-signature",
    formatVersion: 1,
    signatureId,
    attestationId,
    policyId: "dual-control",
    lifecycleRevision: 1,
    lifecycleStatus: "active",
    snapshotId: "snapshot-1",
    policyVersion: 1,
    rootDigest: "a".repeat(64),
    currentStateDigest: "b".repeat(64),
    digestAlgorithm: "SHA-256",
    canonicalization: "nublox-json-canonical-v1",
    signerId,
    algorithm,
    keyId,
    signature: `signature:${signatureId}`,
    payloadDigest: "c".repeat(64),
    signedAt: "2026-09-27T12:40:00.000Z",
  };
}

function policy({ minimumValidSignatures = 2, signers } = {}) {
  return {
    policyId: "lifecycle-governance-trust",
    version: 1,
    minimumValidSignatures,
    signers: signers ?? [
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
      {
        signerId: "audit",
        allowedAlgorithms: ["TEST-SIGN-v1"],
        allowedKeyIds: ["audit-key"],
      },
    ],
  };
}

function fixture(records, { invalid = new Set(), throws = new Set() } = {}) {
  const source = {
    async history(filter = {}) {
      return records
        .filter((record) => filter.attestationId === undefined || record.attestationId === filter.attestationId)
        .map((record) => structuredClone(record));
    },
    async verify(signatureId) {
      if (throws.has(signatureId)) throw new Error("verification unavailable");
      const valid = !invalid.has(signatureId);
      return {
        signatureId,
        valid,
        lifecycleIntegrityValid: valid,
        payloadMatches: valid,
        signatureValid: valid,
        verifiedAt: "2026-09-27T12:41:00.000Z",
      };
    },
  };
  const store = new MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustEvaluationStore();
  const catalog = new RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustCatalog(
    source,
    store,
    () => new Date("2026-09-27T12:42:00.000Z"),
  );
  return { catalog, store, source };
}

test("trusts lifecycle evidence when quorum and required signer constraints are met", async () => {
  const records = [
    signatureRecord({ signatureId: "sig-security", signerId: "security" }),
    signatureRecord({ signatureId: "sig-operations", signerId: "operations" }),
  ];
  const { catalog } = fixture(records);
  const result = await catalog.evaluate({
    evaluationId: "eval-trusted",
    attestationId: "lifecycle-integrity-1",
    policy: policy(),
  });

  assert.equal(result.decision, "trusted");
  assert.deepEqual(result.validSignerIds, ["operations", "security"]);
  assert.deepEqual(result.missingRequiredSignerIds, []);
  assert.equal(result.signatures.filter((item) => item.accepted).length, 2);
});

test("required lifecycle signer remains mandatory even when numerical quorum is met", async () => {
  const records = [
    signatureRecord({ signatureId: "sig-operations", signerId: "operations" }),
    signatureRecord({ signatureId: "sig-audit", signerId: "audit" }),
  ];
  const { catalog } = fixture(records);
  const result = await catalog.evaluate({
    evaluationId: "eval-missing-required",
    attestationId: "lifecycle-integrity-1",
    policy: policy(),
  });

  assert.equal(result.decision, "untrusted");
  assert.deepEqual(result.validSignerIds, ["audit", "operations"]);
  assert.deepEqual(result.missingRequiredSignerIds, ["security"]);
});

test("one signer contributes at most one valid lifecycle signature toward quorum", async () => {
  const records = [
    signatureRecord({ signatureId: "sig-security-a", signerId: "security" }),
    signatureRecord({ signatureId: "sig-security-b", signerId: "security" }),
  ];
  const { catalog } = fixture(records);
  const result = await catalog.evaluate({
    evaluationId: "eval-distinct-signers",
    attestationId: "lifecycle-integrity-1",
    policy: policy({
      minimumValidSignatures: 2,
      signers: [
        { signerId: "security", allowedKeyIds: ["security-key"] },
        { signerId: "operations", allowedKeyIds: ["operations-key"] },
      ],
    }),
  });

  assert.equal(result.decision, "untrusted");
  assert.deepEqual(result.validSignerIds, ["security"]);
  assert.equal(result.signatures.filter((item) => item.accepted).length, 1);
  assert.match(result.signatures.find((item) => !item.accepted).reason, /already contributed/i);
});

test("disallowed keys, unlisted signers and verifier errors fail closed", async () => {
  const records = [
    signatureRecord({ signatureId: "sig-wrong-key", signerId: "security", keyId: "old-security-key" }),
    signatureRecord({ signatureId: "sig-operations", signerId: "operations" }),
    signatureRecord({ signatureId: "sig-intruder", signerId: "intruder" }),
  ];
  const { catalog } = fixture(records, { throws: new Set(["sig-operations"]) });
  const result = await catalog.evaluate({
    evaluationId: "eval-fail-closed",
    attestationId: "lifecycle-integrity-1",
    policy: policy({ minimumValidSignatures: 1 }),
  });

  assert.equal(result.decision, "untrusted");
  assert.deepEqual(result.validSignerIds, []);
  assert.deepEqual(result.missingRequiredSignerIds, ["security"]);
  assert.match(result.signatures.find((item) => item.signatureId === "sig-wrong-key").reason, /key is not allowed/i);
  assert.match(result.signatures.find((item) => item.signatureId === "sig-operations").reason, /failed closed/i);
  assert.match(result.signatures.find((item) => item.signatureId === "sig-intruder").reason, /not allowed/i);
});

test("lifecycle trust evaluations are create-only, detached and filterable", async () => {
  const records = [
    signatureRecord({ signatureId: "sig-security", signerId: "security" }),
    signatureRecord({ signatureId: "sig-operations", signerId: "operations" }),
  ];
  const { catalog } = fixture(records);
  const result = await catalog.evaluate({
    evaluationId: "eval-history",
    attestationId: "lifecycle-integrity-1",
    policy: policy(),
  });
  result.validSignerIds.push("mutated");

  assert.deepEqual((await catalog.get("eval-history")).validSignerIds, ["operations", "security"]);
  assert.equal((await catalog.history({ policyId: "lifecycle-governance-trust" })).length, 1);
  assert.equal((await catalog.history({ decision: "untrusted" })).length, 0);
  await assert.rejects(
    () => catalog.evaluate({
      evaluationId: "eval-history",
      attestationId: "lifecycle-integrity-1",
      policy: policy(),
    }),
    /already exists/i,
  );
});

test("lifecycle trust policy validation rejects impossible quorum and duplicate signers", () => {
  assert.throws(
    () => validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustPolicy({
      policyId: "bad-quorum",
      version: 1,
      minimumValidSignatures: 2,
      signers: [{ signerId: "one" }],
    }),
    /quorum cannot exceed/i,
  );
  assert.throws(
    () => validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustPolicy({
      policyId: "duplicates",
      version: 1,
      minimumValidSignatures: 1,
      signers: [{ signerId: "one" }, { signerId: "one" }],
    }),
    /duplicate/i,
  );
});
