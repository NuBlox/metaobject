import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceStore,
  MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotStore,
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotCatalog,
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceCatalog,
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleGovernedBundleAnchorRootCatalog,
  replayRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernance,
} from "../dist/index.js";

const fixedClock = () => new Date("2026-09-27T14:30:00.000Z");
const roots = [{ authorityId: "enterprise-root", allowedAlgorithms: ["ROOT-SIGN-v1"], allowedKeyIds: ["root-key-2026"] }];

async function setup() {
  const snapshots = new MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotStore();
  const snapshotCatalog = new RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotCatalog(snapshots, fixedClock);
  await snapshotCatalog.publish({ snapshotId: "roots-1", roots });
  const events = new MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceStore();
  const governance = new RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceCatalog(
    snapshots,
    events,
    fixedClock,
  );
  return { snapshots, events, governance };
}

test("activates an immutable M59 root snapshot and replays current state", async () => {
  const { governance } = await setup();
  const active = await governance.activate("event-1", "roots-1");
  assert.deepEqual(active, {
    snapshotId: "roots-1",
    status: "active",
    revision: 1,
    activatedAt: fixedClock().toISOString(),
  });
  assert.equal((await governance.assertActive("roots-1")).status, "active");
  await assert.rejects(governance.activate("event-2", "roots-1"), /already governed/);
});

test("retirement preserves history but blocks new anchor bindings", async () => {
  const { governance } = await setup();
  await governance.activate("event-1", "roots-1");

  const calls = [];
  const governedBindings = new RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleGovernedBundleAnchorRootCatalog(
    governance,
    {
      async verifyAndBind(bindingId, anchorId, snapshotId) {
        calls.push({ bindingId, anchorId, snapshotId });
        return {
          format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-bundle-anchor-root-binding",
          formatVersion: 1,
          bindingId,
          anchorId,
          snapshotId,
          snapshotDigest: "a".repeat(64),
          anchorValid: true,
          authorityTrusted: true,
          signatureValid: true,
          boundAt: fixedClock().toISOString(),
        };
      },
    },
  );

  await governedBindings.verifyAndBind("binding-before-retirement", "anchor-1", "roots-1");
  assert.equal(calls.length, 1);

  const retired = await governance.retire({
    eventId: "event-2",
    snapshotId: "roots-1",
    expectedRevision: 1,
    reason: "scheduled key rollover",
  });
  assert.equal(retired.status, "retired");
  assert.equal(retired.revision, 2);
  assert.equal(retired.reason, "scheduled key rollover");

  await assert.rejects(
    governedBindings.verifyAndBind("binding-after-retirement", "anchor-2", "roots-1"),
    /retired and cannot authorize a new anchor binding/,
  );
  assert.equal(calls.length, 1);
  assert.equal((await governance.history("roots-1")).length, 2);
});

test("revocation is terminal and supports revoking a retired root", async () => {
  const { governance } = await setup();
  await governance.activate("event-1", "roots-1");
  await governance.retire({ eventId: "event-2", snapshotId: "roots-1", expectedRevision: 1 });
  const revoked = await governance.revoke({
    eventId: "event-3",
    snapshotId: "roots-1",
    expectedRevision: 2,
    reason: "authority compromise",
  });
  assert.equal(revoked.status, "revoked");
  assert.equal(revoked.revision, 3);
  assert.equal(revoked.reason, "authority compromise");

  await assert.rejects(
    governance.revoke({ eventId: "event-4", snapshotId: "roots-1", expectedRevision: 3 }),
    /revoked and terminal/,
  );
  await assert.rejects(
    governance.retire({ eventId: "event-5", snapshotId: "roots-1", expectedRevision: 3 }),
    /revoked and terminal/,
  );
});

test("optimistic revision checks reject stale governance transitions", async () => {
  const { governance } = await setup();
  await governance.activate("event-1", "roots-1");
  await assert.rejects(
    governance.retire({ eventId: "event-2", snapshotId: "roots-1", expectedRevision: 2 }),
    /revision is 1, expected 2/,
  );
  assert.equal((await governance.getState("roots-1")).status, "active");
});

test("governance activation fails closed if the underlying M59 snapshot is tampered", async () => {
  const snapshots = new MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotStore();
  const snapshotCatalog = new RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotCatalog(snapshots, fixedClock);
  const published = await snapshotCatalog.publish({ snapshotId: "roots-1", roots });
  const tamperedSnapshots = {
    async get() {
      return { ...published, roots: [{ authorityId: "attacker", allowedKeyIds: ["attacker-key"] }] };
    },
    async list() { return []; },
    async create(record) { return record; },
  };
  const governance = new RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceCatalog(
    tamperedSnapshots,
    new MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceStore(),
    fixedClock,
  );
  await assert.rejects(governance.activate("event-1", "roots-1"), /invalid/);
});

test("replay rejects broken revision sequences and post-revocation mutation", () => {
  const base = {
    format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-external-root-snapshot-governance-event",
    formatVersion: 1,
    snapshotId: "roots-1",
    occurredAt: fixedClock().toISOString(),
  };
  assert.throws(
    () => replayRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernance("roots-1", [
      { ...base, eventId: "event-1", revision: 1, type: "activated" },
      { ...base, eventId: "event-3", revision: 3, type: "retired" },
    ]),
    /revision sequence is invalid/,
  );

  assert.throws(
    () => replayRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernance("roots-1", [
      { ...base, eventId: "event-1", revision: 1, type: "activated" },
      { ...base, eventId: "event-2", revision: 2, type: "revoked" },
      { ...base, eventId: "event-3", revision: 3, type: "retired" },
    ]),
    /events after revocation/,
  );
});
