import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRootBindingStore,
  MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotStore,
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRootBoundCatalog,
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotCatalog,
  digestExternalTrustRoots,
} from "../dist/index.js";

const fixedClock = () => new Date("2026-09-27T13:30:00.000Z");

const roots = [
  { authorityId: "enterprise-root", allowedAlgorithms: ["ROOT-SIGN-v1"], allowedKeyIds: ["root-key-2026"] },
  { authorityId: "backup-root", allowedAlgorithms: ["ROOT-SIGN-v1", "ROOT-SIGN-v2"], allowedKeyIds: ["backup-key"] },
];

test("publishes immutable canonical external trust root snapshots", async () => {
  const store = new MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotStore();
  const catalog = new RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotCatalog(store, fixedClock);

  const published = await catalog.publish({ snapshotId: "roots-1", roots });
  assert.equal(published.snapshotId, "roots-1");
  assert.equal(published.rootDigest, await digestExternalTrustRoots(roots));
  assert.deepEqual(published.roots.map((root) => root.authorityId), ["backup-root", "enterprise-root"]);
  assert.equal((await catalog.verify("roots-1")).valid, true);

  await assert.rejects(
    catalog.publish({ snapshotId: "roots-1", roots }),
    /already exists/,
  );
});

test("canonical digest is independent of input ordering", async () => {
  const reversed = [...roots].reverse().map((root) => ({
    authorityId: root.authorityId,
    allowedAlgorithms: root.allowedAlgorithms === undefined ? undefined : [...root.allowedAlgorithms].reverse(),
    allowedKeyIds: root.allowedKeyIds === undefined ? undefined : [...root.allowedKeyIds].reverse(),
  }));
  assert.equal(await digestExternalTrustRoots(roots), await digestExternalTrustRoots(reversed));
});

test("binds one exact M58 verification to the root snapshot used for trust", async () => {
  const snapshots = new MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotStore();
  const snapshotCatalog = new RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotCatalog(snapshots, fixedClock);
  await snapshotCatalog.publish({ snapshotId: "roots-1", roots });

  const calls = [];
  const anchors = {
    async verify(anchorId, suppliedRoots) {
      calls.push({ anchorId, suppliedRoots: structuredClone(suppliedRoots) });
      return {
        anchorId,
        valid: true,
        bundleValid: true,
        payloadMatches: true,
        authorityTrusted: true,
        signatureValid: true,
        verifiedAt: fixedClock().toISOString(),
      };
    },
  };
  const bindings = new MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRootBindingStore();
  const catalog = new RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRootBoundCatalog(
    snapshots,
    anchors,
    bindings,
    fixedClock,
  );

  const bound = await catalog.verifyAndBind("binding-1", "anchor-1", "roots-1");
  assert.equal(bound.anchorValid, true);
  assert.equal(bound.authorityTrusted, true);
  assert.equal(bound.signatureValid, true);
  assert.equal(bound.snapshotDigest, (await snapshots.get("roots-1")).rootDigest);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].suppliedRoots.map((root) => root.authorityId), ["backup-root", "enterprise-root"]);
});

test("invalid snapshot content fails closed before M58 verification", async () => {
  const validStore = new MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotStore();
  const publisher = new RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotCatalog(validStore, fixedClock);
  const published = await publisher.publish({ snapshotId: "roots-1", roots });

  const tamperedStore = {
    async get() {
      return { ...published, roots: [{ authorityId: "attacker", allowedKeyIds: ["attacker-key"] }] };
    },
    async list() { return []; },
    async create(record) { return record; },
  };
  let called = false;
  const anchors = {
    async verify() {
      called = true;
      throw new Error("must not run");
    },
  };
  const catalog = new RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRootBoundCatalog(
    tamperedStore,
    anchors,
    new MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRootBindingStore(),
    fixedClock,
  );

  await assert.rejects(catalog.verifyAndBind("binding-1", "anchor-1", "roots-1"), /invalid/);
  assert.equal(called, false);
});

test("snapshot and binding history are detached and create-only", async () => {
  const snapshots = new MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotStore();
  const snapshotCatalog = new RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotCatalog(snapshots, fixedClock);
  const published = await snapshotCatalog.publish({ snapshotId: "roots-1", roots });
  const read = await snapshotCatalog.get("roots-1");
  read.roots[0].allowedAlgorithms[0] = "tampered";
  assert.notEqual((await snapshotCatalog.get("roots-1")).roots[0].allowedAlgorithms[0], "tampered");

  const bindings = new MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRootBindingStore();
  const catalog = new RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRootBoundCatalog(
    snapshots,
    { async verify(anchorId) { return { anchorId, valid: false, bundleValid: true, payloadMatches: true, authorityTrusted: false, signatureValid: true, verifiedAt: fixedClock().toISOString() }; } },
    bindings,
    fixedClock,
  );
  await catalog.verifyAndBind("binding-1", "anchor-1", published.snapshotId);
  await assert.rejects(catalog.verifyAndBind("binding-1", "anchor-1", published.snapshotId), /already exists/);
  const history = await catalog.history();
  history[0].anchorValid = true;
  assert.equal((await catalog.get("binding-1")).anchorValid, false);
});
