import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleStore,
  MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotStore,
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleCatalog,
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotCatalog,
} from "../dist/index.js";

function policy(version, minimumValidSignatures = 1) {
  return {
    policyId: "dual-control",
    version,
    minimumValidSignatures,
    signers: [
      { signerId: "security", required: true },
      { signerId: "operations" },
    ],
  };
}

class BoundTrustSource {
  calls = [];

  async evaluate(request) {
    this.calls.push(structuredClone(request));
    return {
      format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-bound",
      formatVersion: 1,
      bindingId: request.bindingId,
      evaluationId: request.evaluationId,
      integrityId: request.integrityId,
      snapshotId: request.snapshotId,
      policyId: "dual-control",
      policyVersion: request.snapshotId.endsWith("3") ? 3 : request.snapshotId.endsWith("2") ? 2 : 1,
      policyDigest: "a".repeat(64),
      decision: "trusted",
      evaluatedAt: "2026-09-27T12:20:00.000Z",
      boundAt: "2026-09-27T12:20:01.000Z",
    };
  }
}

async function setup() {
  const snapshots = new MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotStore();
  const snapshotCatalog = new RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotCatalog(
    snapshots,
    () => new Date("2026-09-27T12:00:00.000Z"),
  );
  for (const version of [1, 2, 3]) {
    await snapshotCatalog.publish({ snapshotId: `snapshot-${version}`, policy: policy(version) });
  }
  const lifecycle = new MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleStore();
  const boundTrust = new BoundTrustSource();
  let tick = 0;
  const catalog = new RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleCatalog(
    snapshots,
    lifecycle,
    boundTrust,
    () => new Date(`2026-09-27T12:${String(10 + tick++).padStart(2, "0")}:00.000Z`),
  );
  return { snapshots, snapshotCatalog, lifecycle, boundTrust, catalog };
}

test("activates policy snapshots forward-only and routes new evaluations through the current snapshot", async () => {
  const { catalog, boundTrust } = await setup();

  const first = await catalog.activate({
    eventId: "activate-1",
    snapshotId: "snapshot-1",
    expectedRevision: 0,
    actorId: "security-admin",
  });
  assert.equal(first.revision, 1);
  assert.equal(first.status, "active");
  assert.equal((await catalog.resolveActive("dual-control")).snapshotId, "snapshot-1");

  await catalog.evaluateCurrent({
    bindingId: "binding-1",
    evaluationId: "evaluation-1",
    integrityId: "integrity-1",
    policyId: "dual-control",
  });
  assert.equal(boundTrust.calls.at(-1).snapshotId, "snapshot-1");

  const second = await catalog.activate({
    eventId: "activate-2",
    snapshotId: "snapshot-2",
    expectedRevision: 1,
    actorId: "security-admin",
    reason: "raise assurance policy",
  });
  assert.equal(second.revision, 2);
  assert.equal(second.policyVersion, 2);

  await catalog.evaluateCurrent({
    bindingId: "binding-2",
    evaluationId: "evaluation-2",
    integrityId: "integrity-2",
    policyId: "dual-control",
  });
  assert.equal(boundTrust.calls.at(-1).snapshotId, "snapshot-2");

  const history = await catalog.history({ policyId: "dual-control", type: "activate" });
  assert.equal(history.length, 2);
  assert.equal(history[1].previousSnapshotId, "snapshot-1");
  assert.equal(history[1].previousPolicyVersion, 1);
});

test("rejects stale revisions and non-forward policy activation without appending history", async () => {
  const { catalog } = await setup();
  await catalog.activate({ eventId: "activate-1", snapshotId: "snapshot-1", expectedRevision: 0, actorId: "admin" });
  await catalog.activate({ eventId: "activate-2", snapshotId: "snapshot-2", expectedRevision: 1, actorId: "admin" });

  await assert.rejects(
    () => catalog.activate({ eventId: "stale", snapshotId: "snapshot-3", expectedRevision: 1, actorId: "admin" }),
    /revision is 2; expected 1/i,
  );
  await assert.rejects(
    () => catalog.activate({ eventId: "backward", snapshotId: "snapshot-1", expectedRevision: 2, actorId: "admin" }),
    /must advance beyond version 2/i,
  );
  assert.equal((await catalog.history()).length, 2);
  assert.equal((await catalog.current("dual-control")).revision, 2);
});

test("retirement blocks new trust decisions but a higher version can later be activated", async () => {
  const { catalog, boundTrust } = await setup();
  await catalog.activate({ eventId: "activate-1", snapshotId: "snapshot-1", expectedRevision: 0, actorId: "admin" });
  const retired = await catalog.retire({
    eventId: "retire-1",
    policyId: "dual-control",
    expectedRevision: 1,
    actorId: "security-admin",
    reason: "policy withdrawn",
  });
  assert.equal(retired.status, "retired");
  assert.equal(retired.revision, 2);

  await assert.rejects(
    () => catalog.evaluateCurrent({
      bindingId: "binding-retired",
      evaluationId: "evaluation-retired",
      integrityId: "integrity-retired",
      policyId: "dual-control",
    }),
    /retired and cannot authorize new trust evaluations/i,
  );
  assert.equal(boundTrust.calls.length, 0);

  const reactivated = await catalog.activate({
    eventId: "activate-3",
    snapshotId: "snapshot-3",
    expectedRevision: 2,
    actorId: "security-admin",
  });
  assert.equal(reactivated.status, "active");
  assert.equal(reactivated.policyVersion, 3);
  assert.equal(reactivated.revision, 3);
  assert.equal((await catalog.resolveActive("dual-control")).snapshotId, "snapshot-3");
});

test("duplicate lifecycle event IDs fail atomically and do not advance current policy", async () => {
  const { catalog } = await setup();
  await catalog.activate({ eventId: "event-1", snapshotId: "snapshot-1", expectedRevision: 0, actorId: "admin" });

  await assert.rejects(
    () => catalog.activate({ eventId: "event-1", snapshotId: "snapshot-2", expectedRevision: 1, actorId: "admin" }),
    /event 'event-1' already exists/i,
  );
  const current = await catalog.current("dual-control");
  assert.equal(current.revision, 1);
  assert.equal(current.snapshotId, "snapshot-1");
  assert.equal((await catalog.history()).length, 1);
});

test("lifecycle reads and history are detached", async () => {
  const { catalog } = await setup();
  await catalog.activate({ eventId: "activate-1", snapshotId: "snapshot-1", expectedRevision: 0, actorId: "admin" });
  const current = await catalog.current("dual-control");
  current.snapshotId = "mutated";
  assert.equal((await catalog.current("dual-control")).snapshotId, "snapshot-1");

  const history = await catalog.history({ actorId: "admin" });
  history[0].actorId = "mutated";
  assert.equal((await catalog.history({ actorId: "admin" }))[0].actorId, "admin");
});
