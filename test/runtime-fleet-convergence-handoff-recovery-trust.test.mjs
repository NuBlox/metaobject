import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryRuntimeFleetHandoffRecoveryEvidenceTrustEvaluationStore,
  RuntimeFleetHandoffRecoveryEvidenceTrustCatalog,
  validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicy,
} from "../dist/index.js";

function signature(signatureId, signerId, algorithm = "ALG", keyId = `${signerId}-key`) {
  return {
    format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-signature",
    formatVersion: 1,
    signatureId,
    integrityId: "integrity-1",
    attestationId: "attestation-1",
    recoveryId: "recovery-1",
    rootDigest: "a".repeat(64),
    signerId,
    algorithm,
    keyId,
    signature: `sig-${signatureId}`,
    payloadDigest: "b".repeat(64),
    signedAt: "2026-09-27T12:00:00.000Z",
  };
}

function fixture(records, validity = {}) {
  const source = {
    async history({ integrityId }) { return records.filter((item) => item.integrityId === integrityId).map(structuredClone); },
    async verify(id) {
      if (validity[id] instanceof Error) throw validity[id];
      const valid = validity[id] ?? true;
      return { signatureId: id, valid, integrityValid: valid, payloadMatches: valid, signatureValid: valid, verifiedAt: "2026-09-27T12:01:00.000Z" };
    },
  };
  const store = new MemoryRuntimeFleetHandoffRecoveryEvidenceTrustEvaluationStore();
  const catalog = new RuntimeFleetHandoffRecoveryEvidenceTrustCatalog(source, store, () => new Date("2026-09-27T12:02:00.000Z"));
  return { catalog, store };
}

const policy = {
  policyId: "dual-control",
  version: 1,
  minimumValidSignatures: 2,
  signers: [
    { signerId: "security", required: true, allowedAlgorithms: ["ALG"], allowedKeyIds: ["security-key"] },
    { signerId: "operations", allowedAlgorithms: ["ALG"], allowedKeyIds: ["operations-key"] },
    { signerId: "audit", allowedAlgorithms: ["ALG"], allowedKeyIds: ["audit-key"] },
  ],
};

test("trusts a chain when quorum and required signer constraints are met", async () => {
  const { catalog } = fixture([signature("s1", "security"), signature("s2", "operations")]);
  const result = await catalog.evaluate({ evaluationId: "eval-1", integrityId: "integrity-1", policy });
  assert.equal(result.decision, "trusted");
  assert.deepEqual(result.validSignerIds, ["operations", "security"]);
  assert.deepEqual(result.missingRequiredSignerIds, []);
});

test("fails trust when quorum exists but a required signer is missing", async () => {
  const { catalog } = fixture([signature("s1", "operations"), signature("s2", "audit")]);
  const result = await catalog.evaluate({ evaluationId: "eval-2", integrityId: "integrity-1", policy });
  assert.equal(result.decision, "untrusted");
  assert.deepEqual(result.missingRequiredSignerIds, ["security"]);
});

test("counts a signer only once toward quorum", async () => {
  const { catalog } = fixture([signature("s1", "security"), signature("s2", "security")]);
  const result = await catalog.evaluate({ evaluationId: "eval-3", integrityId: "integrity-1", policy });
  assert.equal(result.decision, "untrusted");
  assert.deepEqual(result.validSignerIds, ["security"]);
  assert.equal(result.signatures.filter((item) => item.accepted).length, 1);
});

test("rejects disallowed keys and fail-closed verifier errors", async () => {
  const badKey = signature("s1", "security", "ALG", "wrong-key");
  const ops = signature("s2", "operations");
  const { catalog } = fixture([badKey, ops], { s2: new Error("provider down") });
  const result = await catalog.evaluate({ evaluationId: "eval-4", integrityId: "integrity-1", policy });
  assert.equal(result.decision, "untrusted");
  assert.equal(result.signatures.find((item) => item.signatureId === "s1").reason, "signature key is not allowed by policy");
  assert.equal(result.signatures.find((item) => item.signatureId === "s2").reason, "signature verification failed closed");
});

test("unlisted signers never count toward quorum", async () => {
  const { catalog } = fixture([signature("s1", "security"), signature("s2", "unknown")]);
  const result = await catalog.evaluate({ evaluationId: "eval-5", integrityId: "integrity-1", policy });
  assert.equal(result.decision, "untrusted");
  assert.deepEqual(result.validSignerIds, ["security"]);
});

test("evaluations are create-only, detached and filterable", async () => {
  const { catalog } = fixture([signature("s1", "security"), signature("s2", "operations")]);
  const result = await catalog.evaluate({ evaluationId: "eval-history", integrityId: "integrity-1", policy });
  result.validSignerIds[0] = "mutated";
  assert.notEqual((await catalog.get("eval-history")).validSignerIds[0], "mutated");
  assert.equal((await catalog.history({ decision: "trusted" })).length, 1);
  await assert.rejects(() => catalog.evaluate({ evaluationId: "eval-history", integrityId: "integrity-1", policy }), /already exists/i);
});

test("trust policy validation rejects impossible quorum and duplicate signers", () => {
  assert.throws(() => validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicy({ policyId: "bad", version: 1, minimumValidSignatures: 2, signers: [{ signerId: "one" }] }), /quorum cannot exceed/i);
  assert.throws(() => validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicy({ policyId: "bad", version: 1, minimumValidSignatures: 1, signers: [{ signerId: "one" }, { signerId: "one" }] }), /duplicate/i);
});
