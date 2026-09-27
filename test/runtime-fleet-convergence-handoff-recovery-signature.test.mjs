import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryRuntimeFleetHandoffRecoveryEvidenceSignatureStore,
  RuntimeFleetHandoffRecoveryEvidenceSignatureCatalog,
  RuntimeFleetHandoffRecoveryEvidenceSignatureProviderRegistry,
  signaturePayload,
} from "../dist/index.js";

function integrityRecord() {
  const digest = "a".repeat(64);
  return {
    format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-integrity",
    formatVersion: 1,
    integrityId: "integrity-1",
    attestationId: "attestation-1",
    recoveryId: "recovery-1",
    resolutionId: "resolution-1",
    executionId: "execution-1",
    reservationId: "reservation-1",
    admissionId: "admission-1",
    algorithm: "SHA-256",
    canonicalization: "nublox-json-canonical-v1",
    components: [
      { component: "audit", present: true, digest },
      { component: "resolution", present: true, digest },
      { component: "execution", present: true, digest },
      { component: "reservation", present: true, digest },
      { component: "admission", present: true, digest },
      { component: "attestation", present: true, digest },
    ],
    rootDigest: "b".repeat(64),
    createdAt: "2026-09-27T12:00:00.000Z",
  };
}

function fixture({ integrityValid = true, providerThrows = false } = {}) {
  const current = integrityRecord();
  const source = {
    async get(id) { return id === current.integrityId ? structuredClone(current) : null; },
    async verify(id) {
      return {
        integrityId: id,
        valid: integrityValid,
        expectedRootDigest: current.rootDigest,
        actualRootDigest: current.rootDigest,
        mismatchedComponents: integrityValid ? [] : ["resolution"],
        verifiedAt: "2026-09-27T12:01:00.000Z",
      };
    },
  };
  const providers = new RuntimeFleetHandoffRecoveryEvidenceSignatureProviderRegistry();
  providers.register({
    signerId: "kms-primary",
    async sign(payload) {
      return { algorithm: "TEST-SIGN-v1", keyId: "key-2026-09", signature: `signed:${payload}` };
    },
    async verify(payload, material) {
      if (providerThrows) throw new Error("verifier unavailable");
      return material.algorithm === "TEST-SIGN-v1"
        && material.keyId === "key-2026-09"
        && material.signature === `signed:${payload}`;
    },
  });
  const store = new MemoryRuntimeFleetHandoffRecoveryEvidenceSignatureStore();
  const catalog = new RuntimeFleetHandoffRecoveryEvidenceSignatureCatalog(
    source,
    providers,
    store,
    () => new Date("2026-09-27T12:02:00.000Z"),
  );
  return { catalog, store, source, current, providers };
}

test("signs and verifies the exact canonical M49 integrity payload", async () => {
  const { catalog, current } = fixture();
  const record = await catalog.sign({ signatureId: "signature-1", integrityId: "integrity-1", signerId: "kms-primary" });
  assert.equal(record.integrityId, "integrity-1");
  assert.equal(record.signerId, "kms-primary");
  assert.equal(record.algorithm, "TEST-SIGN-v1");
  assert.equal(record.keyId, "key-2026-09");
  assert.equal(record.signature, `signed:${signaturePayload(current)}`);
  assert.match(record.payloadDigest, /^[0-9a-f]{64}$/);

  const verified = await catalog.verify(record.signatureId);
  assert.equal(verified.valid, true);
  assert.equal(verified.integrityValid, true);
  assert.equal(verified.payloadMatches, true);
  assert.equal(verified.signatureValid, true);
});

test("refuses to sign an M49 integrity record that no longer verifies", async () => {
  const { catalog } = fixture({ integrityValid: false });
  await assert.rejects(
    () => catalog.sign({ signatureId: "signature-invalid", integrityId: "integrity-1", signerId: "kms-primary" }),
    /no longer valid and cannot be signed/i,
  );
});

test("verification fails when the current M49 root no longer matches the signed payload", async () => {
  const { catalog, current } = fixture();
  await catalog.sign({ signatureId: "signature-1", integrityId: "integrity-1", signerId: "kms-primary" });
  current.rootDigest = "c".repeat(64);
  const verified = await catalog.verify("signature-1");
  assert.equal(verified.valid, false);
  assert.equal(verified.payloadMatches, false);
  assert.equal(verified.signatureValid, false);
});

test("provider verification errors fail closed", async () => {
  const { catalog } = fixture({ providerThrows: true });
  await catalog.sign({ signatureId: "signature-1", integrityId: "integrity-1", signerId: "kms-primary" });
  const verified = await catalog.verify("signature-1");
  assert.equal(verified.valid, false);
  assert.equal(verified.payloadMatches, true);
  assert.equal(verified.signatureValid, false);
});

test("signature records are create-only, detached and filterable", async () => {
  const { catalog } = fixture();
  const record = await catalog.sign({ signatureId: "signature-history", integrityId: "integrity-1", signerId: "kms-primary" });
  record.signature = "mutated";
  assert.notEqual((await catalog.get("signature-history")).signature, "mutated");
  assert.equal((await catalog.history({ signerId: "kms-primary" })).length, 1);
  assert.equal((await catalog.history({ keyId: "other" })).length, 0);
  await assert.rejects(
    () => catalog.sign({ signatureId: "signature-history", integrityId: "integrity-1", signerId: "kms-primary" }),
    /already exists/i,
  );
});

test("duplicate signature providers are rejected", () => {
  const registry = new RuntimeFleetHandoffRecoveryEvidenceSignatureProviderRegistry();
  const provider = { signerId: "one", async sign() { return { algorithm: "a", keyId: "k", signature: "s" }; }, async verify() { return true; } };
  registry.register(provider);
  assert.throws(() => registry.register(provider), /already registered/i);
});
