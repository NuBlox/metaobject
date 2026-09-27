import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationStore,
  MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceStore,
  MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotStore,
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationCatalog,
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotCatalog,
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceCatalog,
  replayRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotation,
} from "../dist/index.js";

const fixedClock = () => new Date("2026-09-27T14:00:00.000Z");
const oldRoots = [{ authorityId: "enterprise-root", allowedAlgorithms: ["ROOT-SIGN-v1"], allowedKeyIds: ["root-key-2026"] }];
const newRoots = [{ authorityId: "enterprise-root", allowedAlgorithms: ["ROOT-SIGN-v2"], allowedKeyIds: ["root-key-2027"] }];
const thirdRoots = [{ authorityId: "enterprise-root", allowedAlgorithms: ["ROOT-SIGN-v3"], allowedKeyIds: ["root-key-2028"] }];

async function setup(snapshotStore = new MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotStore()) {
  const snapshots = new RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotCatalog(snapshotStore, fixedClock);
  await snapshots.publish({ snapshotId: "roots-old", roots: oldRoots });
  await snapshots.publish({ snapshotId: "roots-new", roots: newRoots });
  await snapshots.publish({ snapshotId: "roots-third", roots: thirdRoots });

  const governanceStore = new MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceStore();
  const governance = new RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceCatalog(
    snapshotStore,
    governanceStore,
    fixedClock,
  );
  await governance.activate("activate-old", "roots-old");

  const rotationStore = new MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationStore();
  const rotations = new RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationCatalog(
    snapshotStore,
    governance,
    rotationStore,
    fixedClock,
  );
  return { snapshotStore, snapshots, governance, governanceStore, rotations, rotationStore };
}

const request = {
  rotationId: "rotation-2027",
  predecessorSnapshotId: "roots-old",
  successorSnapshotId: "roots-new",
};

test("rotates active trust roots through a durable four-stage provenance chain", async () => {
  const { governance, rotations } = await setup();
  const completed = await rotations.rotate(request);

  assert.equal(completed.status, "completed");
  assert.equal(completed.revision, 4);
  assert.equal((await governance.getState("roots-old")).status, "retired");
  assert.equal((await governance.getState("roots-new")).status, "active");
  assert.deepEqual((await rotations.history("rotation-2027")).map((event) => event.type), [
    "planned",
    "successor-activated",
    "predecessor-retired",
    "completed",
  ]);

  const again = await rotations.rotate(request);
  assert.equal(again.status, "completed");
  assert.equal((await rotations.history("rotation-2027")).length, 4);
});

test("resumes safely when successor activation committed before rotation stage evidence", async () => {
  const { governance, rotations } = await setup();
  await rotations.plan(request);
  await governance.activate("rotation-2027:m60:activate-successor", "roots-new");

  const completed = await rotations.resume("rotation-2027");
  assert.equal(completed.status, "completed");
  assert.equal((await governance.getState("roots-old")).status, "retired");
  assert.equal((await rotations.history("rotation-2027")).length, 4);
});

test("fails closed when an unrelated actor activates the planned successor", async () => {
  const { governance, rotations } = await setup();
  await rotations.plan(request);
  await governance.activate("independent-activation", "roots-new");

  await assert.rejects(rotations.resume("rotation-2027"), /does not match this rotation/);
  assert.equal((await governance.getState("roots-old")).status, "active");
  assert.equal((await rotations.history("rotation-2027")).length, 1);
});

test("frozen snapshot digests fail closed if trust material is later tampered", async () => {
  const base = new MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotStore();
  let tamper = false;
  const proxy = {
    async get(snapshotId) {
      const record = await base.get(snapshotId);
      if (!record || !tamper || snapshotId !== "roots-new") return record;
      return { ...record, roots: [{ authorityId: "attacker-root", allowedKeyIds: ["attacker-key"] }] };
    },
    async list() { return base.list(); },
    async create(record) { return base.create(record); },
  };
  const { rotations } = await setup(proxy);
  await rotations.plan(request);
  tamper = true;

  await assert.rejects(rotations.resume("rotation-2027"), /invalid/);
  assert.equal((await rotations.history("rotation-2027")).length, 1);
});

test("one predecessor cannot acquire competing successors and one successor cannot have competing predecessors", async () => {
  const { governance, rotations } = await setup();
  await rotations.plan(request);

  await assert.rejects(
    rotations.plan({ rotationId: "rotation-competing", predecessorSnapshotId: "roots-old", successorSnapshotId: "roots-third" }),
    /already has a recorded successor/,
  );

  await rotations.rotate(request);
  await governance.activate("activate-third", "roots-third");
  await assert.rejects(
    rotations.plan({ rotationId: "rotation-reuse-successor", predecessorSnapshotId: "roots-third", successorSnapshotId: "roots-new" }),
    /already the successor of another rotation/,
  );
});

test("rotation replay rejects sequence gaps and frozen identity mutation", () => {
  const base = {
    format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-external-root-rotation-event",
    formatVersion: 1,
    rotationId: "rotation-2027",
    predecessorSnapshotId: "roots-old",
    predecessorDigest: "old-digest",
    successorSnapshotId: "roots-new",
    successorDigest: "new-digest",
    occurredAt: fixedClock().toISOString(),
  };

  assert.throws(
    () => replayRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotation("rotation-2027", [
      { ...base, eventId: "planned", revision: 1, type: "planned" },
      { ...base, eventId: "retired", revision: 3, type: "predecessor-retired" },
    ]),
    /sequence is invalid/,
  );

  assert.throws(
    () => replayRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotation("rotation-2027", [
      { ...base, eventId: "planned", revision: 1, type: "planned" },
      { ...base, successorDigest: "changed", eventId: "activated", revision: 2, type: "successor-activated" },
    ]),
    /frozen snapshot identity changed/,
  );
});
