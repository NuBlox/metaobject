import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationStore,
  MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceStore,
  MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotStore,
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootChainResolver,
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationCatalog,
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotCatalog,
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceCatalog,
} from "../dist/index.js";

const fixedClock = () => new Date("2026-09-27T15:00:00.000Z");
const root = (keyId) => [{ authorityId: "enterprise-root", allowedAlgorithms: ["ROOT-SIGN-v1"], allowedKeyIds: [keyId] }];

async function createSystem(snapshotStore = new MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotStore()) {
  const snapshots = new RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotCatalog(snapshotStore, fixedClock);
  const governanceStore = new MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceStore();
  const governance = new RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceCatalog(
    snapshotStore,
    governanceStore,
    fixedClock,
  );
  const rotationStore = new MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationStore();
  const rotations = new RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationCatalog(
    snapshotStore,
    governance,
    rotationStore,
    fixedClock,
  );
  const resolver = new RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootChainResolver(
    snapshotStore,
    governance,
    rotations,
    fixedClock,
  );
  return { snapshots, governance, rotations, resolver, snapshotStore };
}

async function publish(system, snapshotId, keyId) {
  return system.snapshots.publish({ snapshotId, roots: root(keyId) });
}

test("resolves a single governed bootstrap root as authoritative", async () => {
  const system = await createSystem();
  const snapshot = await publish(system, "roots-a", "key-a");
  await system.governance.activate("activate-a", "roots-a");

  const resolution = await system.resolver.resolve();
  assert.equal(resolution.valid, true);
  assert.equal(resolution.authoritativeSnapshotId, "roots-a");
  assert.equal(resolution.authoritativeRootDigest, snapshot.rootDigest);
  assert.deepEqual(resolution.lineage.map((entry) => entry.snapshotId), ["roots-a"]);
  assert.deepEqual(resolution.completedRotationIds, []);
});

test("resolves a multi-generation completed rotation chain to its one active tip", async () => {
  const system = await createSystem();
  await publish(system, "roots-a", "key-a");
  await publish(system, "roots-b", "key-b");
  await publish(system, "roots-c", "key-c");
  await system.governance.activate("activate-a", "roots-a");

  await system.rotations.rotate({ rotationId: "rotation-ab", predecessorSnapshotId: "roots-a", successorSnapshotId: "roots-b" });
  await system.rotations.rotate({ rotationId: "rotation-bc", predecessorSnapshotId: "roots-b", successorSnapshotId: "roots-c" });

  const resolution = await system.resolver.resolve();
  assert.equal(resolution.authoritativeSnapshotId, "roots-c");
  assert.deepEqual(resolution.lineage.map((entry) => entry.snapshotId), ["roots-a", "roots-b", "roots-c"]);
  assert.deepEqual(resolution.lineage.map((entry) => entry.governanceStatus), ["retired", "retired", "active"]);
  assert.deepEqual(resolution.completedRotationIds, ["rotation-ab", "rotation-bc"]);
});

test("fails closed instead of choosing between competing active roots", async () => {
  const system = await createSystem();
  await publish(system, "roots-a", "key-a");
  await publish(system, "roots-b", "key-b");
  await system.governance.activate("activate-a", "roots-a");
  await system.governance.activate("activate-b", "roots-b");

  await assert.rejects(system.resolver.resolve(), /exactly one active snapshot; found 2/);
});

test("fails closed while a root rotation is incomplete", async () => {
  const system = await createSystem();
  await publish(system, "roots-a", "key-a");
  await publish(system, "roots-b", "key-b");
  await system.governance.activate("activate-a", "roots-a");
  await system.rotations.plan({ rotationId: "rotation-ab", predecessorSnapshotId: "roots-a", successorSnapshotId: "roots-b" });

  await assert.rejects(system.resolver.resolve(), /rotations are incomplete: rotation-ab/);
});

test("fails closed when immutable root material no longer matches its digest", async () => {
  const base = new MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotStore();
  let tamper = false;
  const proxy = {
    async get(snapshotId) {
      const record = await base.get(snapshotId);
      if (!record || !tamper || snapshotId !== "roots-a") return record;
      return { ...record, roots: root("attacker-key") };
    },
    async list() {
      const records = await base.list();
      return records.map((record) => record.snapshotId === "roots-a" && tamper
        ? { ...record, roots: root("attacker-key") }
        : record);
    },
    async create(record) { return base.create(record); },
  };
  const system = await createSystem(proxy);
  await publish(system, "roots-a", "key-a");
  await system.governance.activate("activate-a", "roots-a");
  tamper = true;

  await assert.rejects(system.resolver.resolve(), /snapshot 'roots-a' is invalid/);
});

test("rejects disconnected completed rotation islands even when only one tip remains active", async () => {
  const system = await createSystem();
  for (const [snapshotId, keyId] of [["roots-a", "key-a"], ["roots-b", "key-b"], ["roots-c", "key-c"], ["roots-d", "key-d"]]) {
    await publish(system, snapshotId, keyId);
  }
  await system.governance.activate("activate-a", "roots-a");
  await system.governance.activate("activate-c", "roots-c");
  await system.rotations.rotate({ rotationId: "rotation-ab", predecessorSnapshotId: "roots-a", successorSnapshotId: "roots-b" });
  await system.rotations.rotate({ rotationId: "rotation-cd", predecessorSnapshotId: "roots-c", successorSnapshotId: "roots-d" });
  const d = await system.governance.getState("roots-d");
  await system.governance.retire({
    eventId: "retire-d-manually",
    snapshotId: "roots-d",
    expectedRevision: d.revision,
    reason: "No longer authoritative.",
  });

  await assert.rejects(system.resolver.resolve(), /do not form one authoritative lineage/);
});
