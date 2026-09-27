import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalizeJson,
  MemoryRuntimeFleetHandoffRecoveryEvidenceIntegrityStore,
  RuntimeFleetHandoffRecoveryEvidenceIntegrityCatalog,
  sha256Hex,
} from "../dist/index.js";

function identity() {
  return {
    dispatchId: "dispatch-1",
    workerId: "worker-a",
    handoffAt: "2026-09-27T11:58:00.000Z",
    work: [{ workId: "work-1", runtimeId: "runtime-1", action: "review", workRevision: 1, fairnessRank: 1 }],
  };
}

function makeFixture({ withoutAdmission = false } = {}) {
  const audit = {
    format: "nublox-metaobject-runtime-fleet-handoff-recovery-audit", formatVersion: 1,
    recoveryId: "recovery-1", policyId: "default-recovery", policyVersion: 1,
    decisions: [{ reservationId: "reservation-1", reservationRevision: 2, admissionId: "admission-1", dispatchId: "dispatch-1", workerId: "worker-a", handoffAt: "2026-09-27T11:58:00.000Z", ageMs: 120000, action: "review", reason: "manual review required" }],
    total: 1, resume: 0, cancel: 0, review: 1, evaluatedAt: "2026-09-27T12:00:00.000Z",
  };
  const resolution = {
    format: "nublox-metaobject-runtime-fleet-handoff-recovery-resolution", formatVersion: 1,
    resolutionId: "resolution-resume", recoveryId: "recovery-1", reservationId: "reservation-1", reservationRevision: 2,
    admissionId: "admission-1", dispatchId: "dispatch-1", workerId: "worker-a", handoffAt: "2026-09-27T11:58:00.000Z",
    action: "resume", actorId: "operator-1", reason: "resume approved", resolvedAt: "2026-09-27T12:01:00.000Z",
  };
  const execution = {
    format: "nublox-metaobject-runtime-fleet-handoff-resolution-execution", formatVersion: 1,
    executionId: "execution-resume", revision: 2, status: "completed", resolutionId: "resolution-resume", recoveryId: "recovery-1",
    reservationId: "reservation-1", action: "resume", actorId: "operator-1", startReservationRevision: 2, admissionId: "admission-1",
    handoffIdentity: identity(), startedAt: "2026-09-27T12:02:00.000Z", outcome: "resumed",
    finalReservationStatus: "consumed", finalReservationRevision: 3,
    ...(withoutAdmission ? {} : { finalAdmissionStatus: "completed", finalAdmissionRevision: 2 }),
    finishedAt: "2026-09-27T12:03:00.000Z",
  };
  const reservation = {
    format: "nublox-metaobject-runtime-fleet-fair-reservation", formatVersion: 1,
    reservationId: "reservation-1", revision: 3, status: "consumed", fairnessId: "fair-1", fairnessPolicyId: "fairness", fairnessPolicyVersion: 1,
    sourceEvaluationId: "queue-1", admissionId: "admission-1", dispatchId: "dispatch-1", workerId: "worker-a", work: identity().work,
    acquiredAt: "2026-09-27T10:00:00.000Z", expiresAt: "2026-09-27T10:01:00.000Z", handoffAt: "2026-09-27T11:58:00.000Z",
    fairAdmissionStatus: "completed", dispatchOutcome: "completed", finishedAt: "2026-09-27T12:03:00.000Z",
  };
  const admission = withoutAdmission ? null : {
    format: "nublox-metaobject-runtime-fleet-fair-dispatch", formatVersion: 1,
    admissionId: "admission-1", revision: 2, status: "completed", fairnessId: "fair-1", fairnessPolicyId: "fairness", fairnessPolicyVersion: 1,
    sourceEvaluationId: "queue-1", sourcePolicyId: "safety", sourcePolicyVersion: 1, dispatchId: "dispatch-1", workerId: "worker-a",
    work: identity().work.map((item) => ({ workId: item.workId, runtimeId: item.runtimeId, action: item.action, evaluatedRevision: item.workRevision, fairnessRank: item.fairnessRank, effectivePriority: 10, starved: false })),
    admittedAt: "2026-09-27T12:02:10.000Z", dispatchOutcome: "completed", finishedAt: "2026-09-27T12:02:30.000Z",
  };
  const attestation = {
    format: "nublox-metaobject-runtime-fleet-handoff-recovery-chain-attestation", formatVersion: 1,
    attestationId: "attestation-1", recoveryId: "recovery-1", policyId: "default-recovery", policyVersion: 1,
    resolutionId: "resolution-resume", executionId: "execution-resume", reservationId: "reservation-1", admissionId: "admission-1",
    action: "resume", actorId: "operator-1", outcome: "resumed", handoffIdentity: identity(), finalReservationStatus: "consumed",
    finalReservationRevision: 3,
    ...(withoutAdmission ? {} : { finalAdmissionStatus: "completed", finalAdmissionRevision: 2 }),
    verifiedAt: "2026-09-27T12:04:00.000Z",
  };

  const values = { audit, resolution, execution, reservation, admission, attestation };
  const src = (value, key) => ({ async get(id) { return value !== null && value[key] === id ? structuredClone(value) : null; } });
  const store = new MemoryRuntimeFleetHandoffRecoveryEvidenceIntegrityStore();
  const catalog = new RuntimeFleetHandoffRecoveryEvidenceIntegrityCatalog(
    src(attestation, "attestationId"), src(audit, "recoveryId"), src(resolution, "resolutionId"), src(execution, "executionId"),
    src(reservation, "reservationId"), src(admission, "admissionId"), store, () => new Date("2026-09-27T12:05:00.000Z"),
  );
  return { catalog, store, values };
}

test("canonical JSON is key-order independent and SHA-256 is deterministic", async () => {
  assert.equal(canonicalizeJson({ b: 2, a: { d: 4, c: 3 } }), canonicalizeJson({ a: { c: 3, d: 4 }, b: 2 }));
  assert.equal(await sha256Hex("nublox"), await sha256Hex("nublox"));
  assert.match(await sha256Hex("nublox"), /^[0-9a-f]{64}$/);
});

test("creates and verifies an integrity root over the complete M44-M48 evidence chain", async () => {
  const { catalog } = makeFixture();
  const record = await catalog.create({ integrityId: "integrity-1", attestationId: "attestation-1" });
  assert.equal(record.components.length, 6);
  assert.equal(record.components.find((item) => item.component === "admission").present, true);
  assert.match(record.rootDigest, /^[0-9a-f]{64}$/);
  const verified = await catalog.verify("integrity-1");
  assert.equal(verified.valid, true);
  assert.deepEqual(verified.mismatchedComponents, []);
});

test("detects mutation of one previously-digested evidence component", async () => {
  const { catalog, values } = makeFixture();
  await catalog.create({ integrityId: "integrity-1", attestationId: "attestation-1" });
  values.resolution.reason = "tampered after integrity snapshot";
  const verified = await catalog.verify("integrity-1");
  assert.equal(verified.valid, false);
  assert.deepEqual(verified.mismatchedComponents, ["resolution"]);
  assert.notEqual(verified.actualRootDigest, verified.expectedRootDigest);
});

test("supports an attested chain where M40 admission is intentionally absent", async () => {
  const { catalog } = makeFixture({ withoutAdmission: true });
  const record = await catalog.create({ integrityId: "integrity-no-admission", attestationId: "attestation-1" });
  const admission = record.components.find((item) => item.component === "admission");
  assert.deepEqual(admission, { component: "admission", present: false });
  assert.equal((await catalog.verify(record.integrityId)).valid, true);
});

test("integrity records are create-only and detached", async () => {
  const { catalog } = makeFixture();
  const record = await catalog.create({ integrityId: "integrity-history", attestationId: "attestation-1" });
  record.components[0].digest = "0".repeat(64);
  const persisted = await catalog.get("integrity-history");
  assert.notEqual(persisted.components[0].digest, "0".repeat(64));
  assert.equal((await catalog.history({ recoveryId: "recovery-1" })).length, 1);
  await assert.rejects(
    () => catalog.create({ integrityId: "integrity-history", attestationId: "attestation-1" }),
    /already exists/i,
  );
});
