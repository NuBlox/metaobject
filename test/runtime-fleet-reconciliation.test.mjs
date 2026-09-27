import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryRuntimeFleetReconciliationStore,
  MemoryRuntimeTargetStore,
  RuntimeFleetReconciliationCatalog,
} from "../dist/index.js";

function observation({ profileId = "production", profileVersion = 2, postureState = "verified", suffix = "1" } = {}) {
  return {
    profileId,
    profileVersion,
    deploymentId: `deployment-${suffix}`,
    baselineId: `baseline-${suffix}`,
    assessmentId: `assessment-${suffix}`,
    postureSnapshotId: `snapshot-${suffix}`,
    postureState,
    observedAt: "2026-09-27T10:00:00.000Z",
  };
}

function record(runtimeId, {
  desiredProfileId = "production",
  desiredProfileVersion = 2,
  observed,
  status = "active",
} = {}) {
  return {
    format: "nublox-metaobject-runtime-target",
    formatVersion: 1,
    runtimeId,
    revision: 0,
    status,
    desiredProfile: { profileId: desiredProfileId, profileVersion: desiredProfileVersion },
    ...(observed === undefined ? {} : { observation: observed }),
    createdAt: "2026-09-27T09:00:00.000Z",
    updatedAt: "2026-09-27T09:00:00.000Z",
    ...(status === "retired" ? { retiredAt: "2026-09-27T09:30:00.000Z" } : {}),
  };
}

async function fixture(records) {
  const targets = new MemoryRuntimeTargetStore();
  for (const item of records) await targets.save(item, 0);
  const runs = new MemoryRuntimeFleetReconciliationStore();
  const catalog = new RuntimeFleetReconciliationCatalog(
    targets,
    runs,
    () => new Date("2026-09-27T10:30:00.000Z"),
  );
  return { targets, runs, catalog };
}

test("classifies the complete desired-versus-observed fleet decision matrix", async () => {
  const { catalog } = await fixture([
    record("compliant", { observed: observation({ suffix: "compliant" }) }),
    record("behind", { desiredProfileVersion: 3, observed: observation({ profileVersion: 2, suffix: "behind" }) }),
    record("ahead", { desiredProfileVersion: 1, observed: observation({ profileVersion: 2, suffix: "ahead" }) }),
    record("mismatch", { observed: observation({ profileId: "staging", suffix: "mismatch" }) }),
    record("unobserved"),
    record("warning", { observed: observation({ postureState: "warning", suffix: "warning" }) }),
    record("drifted", { observed: observation({ postureState: "drifted", suffix: "drifted" }) }),
    record("remediating", { observed: observation({ postureState: "remediating", suffix: "remediating" }) }),
    record("review", { observed: observation({ postureState: "review", suffix: "review" }) }),
    record("stale", { observed: observation({ postureState: "stale", suffix: "stale" }) }),
    record("retired", { status: "retired", observed: observation({ suffix: "retired" }) }),
  ]);

  const run = await catalog.reconcile({ runId: "fleet-reconcile-1" });
  const byId = new Map(run.targets.map((target) => [target.runtimeId, target]));

  assert.deepEqual(
    [...byId].map(([runtimeId, target]) => [runtimeId, target.compliance, target.recommendedAction]),
    [
      ["ahead", "profile-ahead", "review"],
      ["behind", "profile-behind", "plan-profile-upgrade"],
      ["compliant", "compliant", "none"],
      ["drifted", "drifted", "plan-remediation"],
      ["mismatch", "profile-mismatch", "review"],
      ["remediating", "remediating", "wait-remediation"],
      ["retired", "retired", "none"],
      ["review", "review", "review"],
      ["stale", "stale", "reassess"],
      ["unobserved", "unobserved", "establish-observation"],
      ["warning", "warning", "reassess"],
    ],
  );
  assert.equal(run.outcome, "review-required");
  assert.equal(run.total, 11);
  assert.equal(run.compliant, 1);
  assert.equal(run.reviewRequired, 3);
  assert.equal(run.actionRequired, 6);
  assert.equal(run.retired, 1);
});

test("reconciles an explicit fleet subset deterministically", async () => {
  const { catalog } = await fixture([
    record("runtime-z", { observed: observation({ suffix: "z" }) }),
    record("runtime-a", { desiredProfileVersion: 3, observed: observation({ profileVersion: 2, suffix: "a" }) }),
    record("runtime-m", { observed: observation({ postureState: "drifted", suffix: "m" }) }),
  ]);

  const run = await catalog.reconcile({
    runId: "fleet-reconcile-subset",
    runtimeIds: ["runtime-z", "runtime-a"],
  });
  assert.deepEqual(run.targets.map((target) => target.runtimeId), ["runtime-a", "runtime-z"]);
  assert.equal(run.outcome, "action-required");
  assert.equal(run.actionRequired, 1);
  assert.equal(run.compliant, 1);
});

test("duplicate and unknown requested runtimes are rejected before persistence", async () => {
  const { catalog, runs } = await fixture([record("runtime-a")]);
  await assert.rejects(
    () => catalog.reconcile({ runId: "duplicate", runtimeIds: ["runtime-a", "runtime-a"] }),
    /duplicate runtime/i,
  );
  await assert.rejects(
    () => catalog.reconcile({ runId: "unknown", runtimeIds: ["runtime-missing"] }),
    /unknown runtime target/i,
  );
  assert.equal((await runs.list()).length, 0);
});

test("reconciliation history is immutable and duplicate run ids are rejected", async () => {
  const { catalog, runs } = await fixture([
    record("runtime-a", { observed: observation({ suffix: "a" }) }),
  ]);
  const first = await catalog.reconcile({ runId: "history-1" });
  first.targets[0].reason = "mutated locally";
  const persisted = await catalog.get("history-1");
  assert.notEqual(persisted.targets[0].reason, "mutated locally");

  await assert.rejects(
    () => catalog.reconcile({ runId: "history-1" }),
    /already exists/i,
  );
  assert.equal((await runs.list({ outcome: "compliant" })).length, 1);
});
