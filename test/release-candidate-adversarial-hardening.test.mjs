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
  digestExternalTrustRoots,
  replayRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotation,
  replayRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernance,
} from "../dist/index.js";

const fixedClock = () => new Date("2026-09-27T18:00:00.000Z");
const root = (authorityId, keyId) => [{ authorityId, allowedAlgorithms: ["ROOT-SIGN-v1"], allowedKeyIds: [keyId] }];

const governanceEvent = (overrides = {}) => ({
  format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-external-root-snapshot-governance-event",
  formatVersion: 1,
  eventId: "governance-1",
  snapshotId: "roots-a",
  revision: 1,
  type: "activated",
  occurredAt: "2026-09-27T18:00:00.000Z",
  ...overrides,
});

const rotationEvent = (revision, type, occurredAt, overrides = {}) => ({
  format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-external-root-rotation-event",
  formatVersion: 1,
  eventId: `rotation-ab:${type}`,
  rotationId: "rotation-ab",
  predecessorSnapshotId: "roots-a",
  predecessorDigest: "digest-a",
  successorSnapshotId: "roots-b",
  successorDigest: "digest-b",
  revision,
  type,
  occurredAt,
  ...overrides,
});

async function createSystem() {
  const snapshotStore = new MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotStore();
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
  return { snapshotStore, snapshots, governance, rotations };
}

async function completedRotation() {
  const system = await createSystem();
  await system.snapshots.publish({ snapshotId: "roots-a", roots: root("authority", "key-a") });
  await system.snapshots.publish({ snapshotId: "roots-b", roots: root("authority", "key-b") });
  await system.governance.activate("activate-a", "roots-a");
  await system.rotations.rotate({
    rotationId: "rotation-ab",
    predecessorSnapshotId: "roots-a",
    successorSnapshotId: "roots-b",
  });
  return system;
}

test("M60 governance replay rejects timestamp regression with otherwise valid revisions", () => {
  assert.throws(
    () => replayRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernance("roots-a", [
      governanceEvent({ eventId: "activate", revision: 1, type: "activated", occurredAt: "2026-09-27T18:01:00.000Z" }),
      governanceEvent({ eventId: "retire", revision: 2, type: "retired", occurredAt: "2026-09-27T18:00:00.000Z" }),
    ]),
    /timestamps are not monotonic/,
  );
});

test("M60 governance replay rejects unsupported portable format versions", () => {
  assert.throws(
    () => replayRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernance("roots-a", [
      governanceEvent({ formatVersion: 2 }),
    ]),
    /Unsupported external trust root snapshot governance event format/,
  );
});

test("M61 rotation replay rejects timestamp regression with otherwise valid stage sequence", () => {
  assert.throws(
    () => replayRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotation("rotation-ab", [
      rotationEvent(1, "planned", "2026-09-27T18:00:00.000Z"),
      rotationEvent(2, "successor-activated", "2026-09-27T18:02:00.000Z"),
      rotationEvent(3, "predecessor-retired", "2026-09-27T18:01:00.000Z"),
    ]),
    /timestamps are not monotonic/,
  );
});

test("M61 rotation replay rejects frozen identity mutation and sequence gaps", () => {
  assert.throws(
    () => replayRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotation("rotation-ab", [
      rotationEvent(1, "planned", "2026-09-27T18:00:00.000Z"),
      rotationEvent(2, "successor-activated", "2026-09-27T18:00:00.000Z", { successorDigest: "attacker-digest" }),
    ]),
    /frozen snapshot identity changed/,
  );

  assert.throws(
    () => replayRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotation("rotation-ab", [
      rotationEvent(1, "planned", "2026-09-27T18:00:00.000Z"),
      rotationEvent(3, "predecessor-retired", "2026-09-27T18:00:00.000Z"),
    ]),
    /event sequence is invalid/,
  );
});

test("M62 resolver rejects duplicated immutable snapshot records", async () => {
  const system = await createSystem();
  await system.snapshots.publish({ snapshotId: "roots-a", roots: root("authority", "key-a") });
  await system.governance.activate("activate-a", "roots-a");

  const duplicateSnapshotStore = {
    get: (snapshotId) => system.snapshotStore.get(snapshotId),
    create: (record) => system.snapshotStore.create(record),
    async list() {
      const records = await system.snapshotStore.list();
      return [...records, structuredClone(records[0])];
    },
  };
  const resolver = new RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootChainResolver(
    duplicateSnapshotStore,
    system.governance,
    system.rotations,
    fixedClock,
  );

  await assert.rejects(() => resolver.resolve(), /snapshot 'roots-a' is duplicated/);
});

test("M62 resolver requires exact M61-created governance linkage", async () => {
  const system = await completedRotation();
  const governanceHistory = await system.governance.history();
  const tamperedGovernance = {
    async history() {
      return governanceHistory.map((event) => event.eventId === "rotation-ab:m60:activate-successor"
        ? { ...event, eventId: "attacker:activate-successor" }
        : event);
    },
  };
  const resolver = new RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootChainResolver(
    system.snapshotStore,
    tamperedGovernance,
    system.rotations,
    fixedClock,
  );

  await assert.rejects(() => resolver.resolve(), /lacks its exact successor activation evidence/);
});

test("M62 resolver rejects a consistently rewritten frozen rotation digest", async () => {
  const system = await completedRotation();
  const history = await system.rotations.history();
  const tamperedRotations = {
    async history() {
      return history.map((event) => ({ ...event, successorDigest: "attacker-digest" }));
    },
  };
  const resolver = new RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootChainResolver(
    system.snapshotStore,
    system.governance,
    tamperedRotations,
    fixedClock,
  );

  await assert.rejects(() => resolver.resolve(), /frozen digest does not match immutable snapshot evidence/);
});

test("M59 trust-root digest is canonical across authority and constraint ordering", async () => {
  const first = [
    { authorityId: "z-root", allowedAlgorithms: ["B", "A"], allowedKeyIds: ["key-2", "key-1"] },
    { authorityId: "a-root", allowedAlgorithms: ["C"], allowedKeyIds: ["key-3"] },
  ];
  const permuted = [
    { authorityId: "a-root", allowedAlgorithms: ["C"], allowedKeyIds: ["key-3"] },
    { authorityId: "z-root", allowedAlgorithms: ["A", "B"], allowedKeyIds: ["key-1", "key-2"] },
  ];

  assert.equal(await digestExternalTrustRoots(first), await digestExternalTrustRoots(permuted));
});
