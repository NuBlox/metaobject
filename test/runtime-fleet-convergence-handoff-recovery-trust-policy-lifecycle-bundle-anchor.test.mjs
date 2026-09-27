import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorStore,
  RuntimeFleetHandoffRecoveryEvidenceSignatureProviderRegistry,
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorCatalog,
  lifecycleBundleAnchorPayload,
} from "../dist/index.js";

function bundleRecord() {
  const digest = (char) => char.repeat(64);
  return {
    format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-bundle",
    formatVersion: 1,
    bundleId: "bundle-1",
    attestationId: "integrity-1",
    evaluationId: "evaluation-1",
    policyId: "recovery-policy",
    lifecycleRevision: 1,
    lifecycleState: {
      format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle",
      formatVersion: 1,
      policyId: "recovery-policy",
      revision: 1,
      status: "active",
      snapshotId: "snapshot-1",
      policyVersion: 1,
      activatedAt: "2026-09-27T13:00:00.000Z",
      updatedAt: "2026-09-27T13:00:00.000Z",
    },
    lifecycleEvents: [{
      format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-event",
      formatVersion: 1,
      eventId: "event-1",
      policyId: "recovery-policy",
      revision: 1,
      type: "activate",
      snapshotId: "snapshot-1",
      policyVersion: 1,
      actorId: "admin",
      occurredAt: "2026-09-27T13:00:00.000Z",
    }],
    policySnapshots: [{
      format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-snapshot",
      formatVersion: 1,
      snapshotId: "snapshot-1",
      policyId: "recovery-policy",
      policyVersion: 1,
      algorithm: "SHA-256",
      canonicalization: "nublox-json-canonical-v1",
      policy: {
        policyId: "recovery-policy",
        version: 1,
        minimumValidSignatures: 1,
        signers: [{ signerId: "recovery-signer" }],
      },
      policyDigest: digest("a"),
      publishedAt: "2026-09-27T12:59:00.000Z",
    }],
    lifecycleIntegrity: {
      format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-integrity",
      formatVersion: 1,
      attestationId: "integrity-1",
      policyId: "recovery-policy",
      lifecycleRevision: 1,
      lifecycleStatus: "active",
      snapshotId: "snapshot-1",
      policyVersion: 1,
      algorithm: "SHA-256",
      canonicalization: "nublox-json-canonical-v1",
      events: [{
        eventId: "event-1",
        revision: 1,
        type: "activate",
        snapshotId: "snapshot-1",
        policyVersion: 1,
        digest: digest("b"),
      }],
      snapshots: [{ snapshotId: "snapshot-1", policyVersion: 1, policyDigest: digest("a") }],
      currentStateDigest: digest("c"),
      rootDigest: digest("d"),
      createdAt: "2026-09-27T13:01:00.000Z",
    },
    lifecycleSignatures: [{
      format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-signature",
      formatVersion: 1,
      signatureId: "sig-security",
      attestationId: "integrity-1",
      policyId: "recovery-policy",
      lifecycleRevision: 1,
      lifecycleStatus: "active",
      snapshotId: "snapshot-1",
      policyVersion: 1,
      rootDigest: digest("d"),
      currentStateDigest: digest("c"),
      digestAlgorithm: "SHA-256",
      canonicalization: "nublox-json-canonical-v1",
      signerId: "security",
      algorithm: "TEST-SIGN-v1",
      keyId: "security-key",
      signature: "security-signature",
      payloadDigest: digest("e"),
      signedAt: "2026-09-27T13:02:00.000Z",
    }],
    trustPolicy: {
      policyId: "lifecycle-trust",
      version: 1,
      minimumValidSignatures: 1,
      signers: [{
        signerId: "security",
        required: true,
        allowedAlgorithms: ["TEST-SIGN-v1"],
        allowedKeyIds: ["security-key"],
      }],
    },
    trustEvaluation: {
      format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-signature-trust",
      formatVersion: 1,
      evaluationId: "evaluation-1",
      attestationId: "integrity-1",
      policyId: "lifecycle-trust",
      policyVersion: 1,
      decision: "trusted",
      minimumValidSignatures: 1,
      validSignerIds: ["security"],
      missingRequiredSignerIds: [],
      signatures: [{
        signatureId: "sig-security",
        signerId: "security",
        algorithm: "TEST-SIGN-v1",
        keyId: "security-key",
        valid: true,
        accepted: true,
        reason: "valid lifecycle signature accepted",
      }],
      evaluatedAt: "2026-09-27T13:03:00.000Z",
    },
    algorithm: "SHA-256",
    canonicalization: "nublox-json-canonical-v1",
    componentDigests: {
      lifecycleState: digest("1"),
      lifecycleEvents: digest("2"),
      policySnapshots: digest("3"),
      lifecycleIntegrity: digest("4"),
      lifecycleSignatures: digest("5"),
      trustPolicy: digest("6"),
      trustEvaluation: digest("7"),
    },
    rootDigest: digest("8"),
    createdAt: "2026-09-27T13:04:00.000Z",
  };
}

function fixture({ bundleValid = true, verifyThrows = false, mutateDuringSign = false } = {}) {
  const current = bundleRecord();
  const source = {
    async get(id) { return id === current.bundleId ? structuredClone(current) : null; },
    async verify(id) {
      if (verifyThrows) throw new Error("bundle verifier unavailable");
      return {
        bundleId: id,
        valid: bundleValid,
        componentDigestsMatch: bundleValid,
        rootDigestMatches: bundleValid,
        lifecycleIntegrityValid: bundleValid,
        trustEvaluationMatches: bundleValid,
        trustDecision: current.trustEvaluation.decision,
        expectedRootDigest: current.rootDigest,
        actualRootDigest: current.rootDigest,
        verifiedAt: "2026-09-27T13:05:00.000Z",
      };
    },
  };
  const providers = new RuntimeFleetHandoffRecoveryEvidenceSignatureProviderRegistry();
  providers.register({
    signerId: "enterprise-root",
    async sign(payload) {
      if (mutateDuringSign) current.rootDigest = "9".repeat(64);
      return { algorithm: "ROOT-SIGN-v1", keyId: "root-key-2026", signature: `root:${payload}` };
    },
    async verify(payload, material) {
      return material.algorithm === "ROOT-SIGN-v1"
        && material.keyId === "root-key-2026"
        && material.signature === `root:${payload}`;
    },
  });
  const store = new MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorStore();
  const catalog = new RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorCatalog(
    source,
    providers,
    store,
    () => new Date("2026-09-27T13:06:00.000Z"),
  );
  return { catalog, store, source, providers, current };
}

const trustedRoot = [{
  authorityId: "enterprise-root",
  allowedAlgorithms: ["ROOT-SIGN-v1"],
  allowedKeyIds: ["root-key-2026"],
}];

test("anchors an exact M57 root and verifies it against an out-of-band trust root", async () => {
  const { catalog, current } = fixture();
  const anchor = await catalog.anchor({
    anchorId: "anchor-1",
    bundleId: current.bundleId,
    authorityId: "enterprise-root",
  });

  assert.equal(anchor.bundleRootDigest, current.rootDigest);
  assert.equal(anchor.authorityId, "enterprise-root");
  assert.equal(anchor.algorithm, "ROOT-SIGN-v1");
  assert.equal(anchor.keyId, "root-key-2026");
  assert.equal(anchor.signature, `root:${lifecycleBundleAnchorPayload(current)}`);
  assert.match(anchor.payloadDigest, /^[0-9a-f]{64}$/);

  const verified = await catalog.verify(anchor.anchorId, trustedRoot);
  assert.deepEqual(
    {
      valid: verified.valid,
      bundleValid: verified.bundleValid,
      payloadMatches: verified.payloadMatches,
      authorityTrusted: verified.authorityTrusted,
      signatureValid: verified.signatureValid,
    },
    {
      valid: true,
      bundleValid: true,
      payloadMatches: true,
      authorityTrusted: true,
      signatureValid: true,
    },
  );
});

test("a cryptographically valid anchor is not trusted unless its authority/key is in the external root set", async () => {
  const { catalog } = fixture();
  await catalog.anchor({ anchorId: "anchor-1", bundleId: "bundle-1", authorityId: "enterprise-root" });

  const verified = await catalog.verify("anchor-1", [{
    authorityId: "enterprise-root",
    allowedAlgorithms: ["ROOT-SIGN-v1"],
    allowedKeyIds: ["different-root-key"],
  }]);
  assert.equal(verified.valid, false);
  assert.equal(verified.bundleValid, true);
  assert.equal(verified.payloadMatches, true);
  assert.equal(verified.authorityTrusted, false);
  assert.equal(verified.signatureValid, true);
});

test("external anchor detects replacement of an otherwise internally-valid bundle root", async () => {
  const { catalog, current } = fixture();
  await catalog.anchor({ anchorId: "anchor-1", bundleId: "bundle-1", authorityId: "enterprise-root" });
  current.rootDigest = "f".repeat(64);

  const verified = await catalog.verify("anchor-1", trustedRoot);
  assert.equal(verified.bundleValid, true);
  assert.equal(verified.payloadMatches, false);
  assert.equal(verified.signatureValid, false);
  assert.equal(verified.valid, false);
});

test("refuses to anchor an M57 bundle that does not currently verify", async () => {
  const { catalog } = fixture({ bundleValid: false });
  await assert.rejects(
    () => catalog.anchor({ anchorId: "anchor-invalid", bundleId: "bundle-1", authorityId: "enterprise-root" }),
    /invalid and cannot be externally anchored/i,
  );
});

test("bundle mutation while external signing is in progress fails closed", async () => {
  const { catalog } = fixture({ mutateDuringSign: true });
  await assert.rejects(
    () => catalog.anchor({ anchorId: "anchor-race", bundleId: "bundle-1", authorityId: "enterprise-root" }),
    /changed while its external anchor was being created/i,
  );
});

test("anchor history is create-only, detached and filterable", async () => {
  const { catalog } = fixture();
  const anchor = await catalog.anchor({ anchorId: "anchor-history", bundleId: "bundle-1", authorityId: "enterprise-root" });
  anchor.signature = "mutated";

  assert.notEqual((await catalog.get("anchor-history")).signature, "mutated");
  assert.equal((await catalog.history({ authorityId: "enterprise-root" })).length, 1);
  assert.equal((await catalog.history({ keyId: "other" })).length, 0);
  await assert.rejects(
    () => catalog.anchor({ anchorId: "anchor-history", bundleId: "bundle-1", authorityId: "enterprise-root" }),
    /already exists/i,
  );
});
