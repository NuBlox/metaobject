import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityStore,
  MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleStore,
  MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotStore,
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleCatalog,
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityCatalog,
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotCatalog,
} from "../dist/index.js";

const clone = (value) => structuredClone(value);

async function fixture() {
  let now = "2026-09-27T12:00:00.000Z";
  const snapshots = new MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotStore();
  const snapshotCatalog = new RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotCatalog(snapshots, () => new Date(now));
  const lifecycle = new MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleStore();
  const lifecycleCatalog = new RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleCatalog(
    snapshots,
    lifecycle,
    { async evaluate() { throw new Error("not used"); } },
    () => new Date(now),
  );

  const policy1 = {
    policyId: "dual-control",
    version: 1,
    minimumValidSignatures: 1,
    signers: [{ signerId: "security", required: true, allowedAlgorithms: ["ALG"] }],
  };
  const policy2 = {
    policyId: "dual-control",
    version: 2,
    minimumValidSignatures: 2,
    signers: [
      { signerId: "security", required: true, allowedAlgorithms: ["ALG"] },
      { signerId: "operations", required: true, allowedAlgorithms: ["ALG"] },
    ],
  };

  await snapshotCatalog.publish({ snapshotId: "snapshot-1", policy: policy1 });
  await lifecycleCatalog.activate({ eventId: "event-1", snapshotId: "snapshot-1", expectedRevision: 0, actorId: "admin" });

  now = "2026-09-27T12:01:00.000Z";
  await lifecycleCatalog.retire({ eventId: "event-2", policyId: "dual-control", expectedRevision: 1, actorId: "admin", reason: "rotate policy" });

  now = "2026-09-27T12:02:00.000Z";
  await snapshotCatalog.publish({ snapshotId: "snapshot-2", policy: policy2 });
  await lifecycleCatalog.activate({ eventId: "event-3", snapshotId: "snapshot-2", expectedRevision: 2, actorId: "admin" });

  const current = await lifecycle.get("dual-control");
  const events = await lifecycle.history({ policyId: "dual-control" });
  const snapshot1 = await snapshots.get("snapshot-1");
  const snapshot2 = await snapshots.get("snapshot-2");
  return { snapshots, lifecycle, current, events, snapshot1, snapshot2 };
}

function mutableLifecycle(current, events) {
  return {
    async get(policyId) {
      return policyId === current.policyId ? clone(current) : null;
    },
    async history({ policyId } = {}) {
      return events.filter((event) => policyId === undefined || event.policyId === policyId).map(clone);
    },
  };
}

function mutableSnapshots(records) {
  return {
    async get(snapshotId) {
      const record = records.get(snapshotId);
      return record ? clone(record) : null;
    },
  };
}

test("attests and verifies a complete legal M53 lifecycle", async () => {
  const f = await fixture();
  const store = new MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityStore();
  const catalog = new RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityCatalog(
    f.lifecycle,
    f.snapshots,
    store,
    () => new Date("2026-09-27T12:03:00.000Z"),
  );

  const record = await catalog.create({ attestationId: "lifecycle-integrity-1", policyId: "dual-control" });
  assert.equal(record.lifecycleRevision, 3);
  assert.equal(record.lifecycleStatus, "active");
  assert.equal(record.snapshotId, "snapshot-2");
  assert.equal(record.events.length, 3);
  assert.deepEqual(record.snapshots.map((item) => item.snapshotId), ["snapshot-1", "snapshot-2"]);
  assert.match(record.rootDigest, /^[0-9a-f]{64}$/);

  const verification = await catalog.verify(record.attestationId);
  assert.equal(verification.valid, true);
  assert.equal(verification.chainValid, true);
  assert.equal(verification.eventsMatch, true);
  assert.equal(verification.snapshotsMatch, true);
  assert.equal(verification.currentStateMatches, true);
  assert.equal(verification.rootDigestMatches, true);
});

test("detects mutation of a lifecycle event without losing structural chain validity", async () => {
  const f = await fixture();
  const current = clone(f.current);
  const events = f.events.map(clone);
  const lifecycle = mutableLifecycle(current, events);
  const store = new MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityStore();
  const catalog = new RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityCatalog(lifecycle, f.snapshots, store);

  await catalog.create({ attestationId: "lifecycle-integrity-2", policyId: "dual-control" });
  events[0].actorId = "tampered-actor";

  const verification = await catalog.verify("lifecycle-integrity-2");
  assert.equal(verification.valid, false);
  assert.equal(verification.chainValid, true);
  assert.equal(verification.eventsMatch, false);
  assert.equal(verification.rootDigestMatches, false);
});

test("rejects incomplete or non-contiguous lifecycle history", async () => {
  const f = await fixture();
  const incomplete = [clone(f.events[0]), clone(f.events[2])];
  const catalog = new RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityCatalog(
    mutableLifecycle(clone(f.current), incomplete),
    f.snapshots,
    new MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityStore(),
  );

  await assert.rejects(
    () => catalog.create({ attestationId: "lifecycle-integrity-gap", policyId: "dual-control" }),
    /history is incomplete|not contiguous/i,
  );
});

test("rejects M52 snapshot content whose policy digest no longer matches", async () => {
  const f = await fixture();
  const records = new Map([
    ["snapshot-1", clone(f.snapshot1)],
    ["snapshot-2", clone(f.snapshot2)],
  ]);
  records.get("snapshot-2").policy.signers[0].required = false;

  const catalog = new RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityCatalog(
    f.lifecycle,
    mutableSnapshots(records),
    new MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityStore(),
  );

  await assert.rejects(
    () => catalog.create({ attestationId: "lifecycle-integrity-bad-snapshot", policyId: "dual-control" }),
    /policy digest is invalid/i,
  );
});

test("verification fails closed when current state is no longer derivable from history", async () => {
  const f = await fixture();
  const current = clone(f.current);
  const lifecycle = mutableLifecycle(current, f.events.map(clone));
  const store = new MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityStore();
  const catalog = new RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityCatalog(lifecycle, f.snapshots, store);
  await catalog.create({ attestationId: "lifecycle-integrity-current", policyId: "dual-control" });

  current.updatedAt = "2026-09-27T12:09:00.000Z";
  const verification = await catalog.verify("lifecycle-integrity-current");
  assert.equal(verification.valid, false);
  assert.equal(verification.chainValid, false);
});

test("integrity records are create-only, detached and filterable", async () => {
  const f = await fixture();
  const store = new MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityStore();
  const catalog = new RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityCatalog(f.lifecycle, f.snapshots, store);
  const record = await catalog.create({ attestationId: "lifecycle-integrity-history", policyId: "dual-control" });
  record.events[0].digest = "0".repeat(64);

  const persisted = await catalog.get("lifecycle-integrity-history");
  assert.notEqual(persisted.events[0].digest, "0".repeat(64));
  assert.equal((await catalog.history({ policyId: "dual-control" })).length, 1);
  assert.equal((await catalog.history({ lifecycleStatus: "retired" })).length, 0);
  await assert.rejects(
    () => catalog.create({ attestationId: "lifecycle-integrity-history", policyId: "dual-control" }),
    /already exists/i,
  );
});
