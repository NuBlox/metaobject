import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryRuntimeFleetConvergenceExecutionStore,
  MemoryRuntimeFleetConvergenceQueueEvaluationStore,
  MemoryRuntimeFleetConvergenceWorkStore,
  RuntimeFleetConvergenceEligibilityRuleRegistry,
  RuntimeFleetConvergenceQueuePolicyCatalog,
  validateRuntimeFleetConvergenceQueuePolicy,
} from "../dist/index.js";

function work(workId, runtimeId, action, createdAt, status = "pending") {
  return {
    format: "nublox-metaobject-runtime-fleet-convergence-work",
    formatVersion: 1,
    workId,
    revision: 0,
    reconciliationRunId: "reconcile-1",
    runtimeId,
    targetRevision: 1,
    action,
    reason: action,
    status,
    ...(status === "in-progress" ? { claimedBy: "worker-existing", claimedAt: "2026-09-27T09:50:00.000Z" } : {}),
    createdAt,
    updatedAt: createdAt,
  };
}

async function fixture(items, histories = new Map()) {
  const store = new MemoryRuntimeFleetConvergenceWorkStore();
  await store.createMany(items);
  const convergence = {
    get: (id) => store.get(id),
    list: (filter = {}) => store.list(filter),
  };
  const executions = {
    list: async (workId) => structuredClone(histories.get(workId) ?? []),
  };
  const rules = new RuntimeFleetConvergenceEligibilityRuleRegistry();
  const evaluations = new MemoryRuntimeFleetConvergenceQueueEvaluationStore();
  const catalog = new RuntimeFleetConvergenceQueuePolicyCatalog(
    convergence,
    executions,
    rules,
    evaluations,
    () => new Date("2026-09-27T10:00:00.000Z"),
  );
  return { store, convergence, executions, rules, evaluations, catalog };
}

function policy(overrides = {}) {
  return {
    policyId: "fleet-default",
    version: 1,
    ...overrides,
  };
}

function decision(run, workId) {
  return run.decisions.find((item) => item.workId === workId);
}

test("priority ordering reserves runtime and action capacity deterministically", async () => {
  const items = [
    work("review-a", "runtime-a", "review", "2026-09-27T09:00:00.000Z"),
    work("remediate-a", "runtime-a", "plan-remediation", "2026-09-27T09:01:00.000Z"),
    work("reassess-b", "runtime-b", "reassess", "2026-09-27T09:02:00.000Z"),
    work("reassess-c", "runtime-c", "reassess", "2026-09-27T09:03:00.000Z"),
  ];
  const { catalog } = await fixture(items);
  const run = await catalog.evaluate({
    evaluationId: "eval-priority",
    policy: policy({
      priorities: { "plan-remediation": 100, review: 10, reassess: 50 },
      maxConcurrentByAction: { reassess: 1 },
      runtimeExclusive: true,
    }),
  });

  assert.deepEqual(run.eligibleWorkIds, ["remediate-a", "reassess-b"]);
  assert.deepEqual(decision(run, "review-a").blockReasons, ["runtime-exclusive"]);
  assert.deepEqual(decision(run, "reassess-c").blockReasons, ["action-concurrency"]);
  assert.deepEqual(run.decisions.map((item) => item.priority), [100, 50, 50, 10]);
});

test("already in-progress work consumes action capacity and runtime exclusivity", async () => {
  const items = [
    work("active-upgrade", "runtime-x", "plan-profile-upgrade", "2026-09-27T09:00:00.000Z", "in-progress"),
    work("pending-upgrade", "runtime-y", "plan-profile-upgrade", "2026-09-27T09:01:00.000Z"),
    work("pending-review", "runtime-x", "review", "2026-09-27T09:02:00.000Z"),
  ];
  const { catalog } = await fixture(items);
  const run = await catalog.evaluate({
    evaluationId: "eval-active",
    policy: policy({ maxConcurrentByAction: { "plan-profile-upgrade": 1 } }),
  });

  assert.deepEqual(decision(run, "pending-upgrade").blockReasons, ["action-concurrency"]);
  assert.deepEqual(decision(run, "pending-review").blockReasons, ["runtime-exclusive"]);
});

test("attempt limits and cooldowns block explicitly retried pending work", async () => {
  const histories = new Map([
    ["retry-me", [
      { finishedAt: "2026-09-27T09:40:00.000Z" },
      { finishedAt: "2026-09-27T09:55:00.000Z" },
    ]],
  ]);
  const { catalog } = await fixture([
    work("retry-me", "runtime-a", "reassess", "2026-09-27T09:00:00.000Z"),
  ], histories);

  const run = await catalog.evaluate({
    evaluationId: "eval-retry",
    policy: policy({ defaultMaxAttempts: 2, defaultCooldownMs: 10 * 60 * 1000 }),
  });
  assert.deepEqual(decision(run, "retry-me").blockReasons, ["attempts-exhausted", "cooldown"]);
  assert.match(decision(run, "retry-me").details[1], /10:05:00\.000Z/);
});

test("dependency policy blocks work while prerequisite action remains unfinished", async () => {
  const { catalog } = await fixture([
    work("reassess-a", "runtime-a", "reassess", "2026-09-27T09:00:00.000Z"),
    work("remediate-a", "runtime-a", "plan-remediation", "2026-09-27T09:01:00.000Z"),
  ]);
  const run = await catalog.evaluate({
    evaluationId: "eval-dependency",
    policy: policy({
      runtimeExclusive: false,
      dependencies: { "plan-remediation": ["reassess"] },
      priorities: { "plan-remediation": 100, reassess: 10 },
    }),
  });
  assert.equal(decision(run, "remediate-a").status, "blocked");
  assert.deepEqual(decision(run, "remediate-a").blockReasons, ["dependency"]);
  assert.equal(decision(run, "reassess-a").status, "eligible");
});

test("custom eligibility rules are ordered and fail closed", async () => {
  const { catalog, rules } = await fixture([
    work("manual-review", "runtime-a", "review", "2026-09-27T09:00:00.000Z"),
    work("upgrade", "runtime-b", "plan-profile-upgrade", "2026-09-27T09:01:00.000Z"),
  ]);
  rules.register({
    id: "no-review",
    evaluate: ({ work }) => work.action === "review"
      ? { eligible: false, reason: "Review queue is operator-only." }
      : { eligible: true },
  });
  rules.register({
    id: "fragile-rule",
    evaluate: ({ work }) => {
      if (work.action === "plan-profile-upgrade") throw new Error("policy service unavailable");
      return { eligible: true };
    },
  });

  const run = await catalog.evaluate({
    evaluationId: "eval-rules",
    policy: policy({ runtimeExclusive: false, eligibilityRules: ["no-review", "fragile-rule"] }),
  });
  assert.deepEqual(decision(run, "manual-review").blockReasons, ["eligibility-rule"]);
  assert.match(decision(run, "manual-review").details[0], /operator-only/);
  assert.deepEqual(decision(run, "upgrade").blockReasons, ["eligibility-rule"]);
  assert.match(decision(run, "upgrade").details[0], /failed closed/);
});

test("queue evaluation history is create-only and detached", async () => {
  const { catalog, evaluations } = await fixture([
    work("work-a", "runtime-a", "reassess", "2026-09-27T09:00:00.000Z"),
  ]);
  const run = await catalog.evaluate({ evaluationId: "eval-history", policy: policy() });
  run.eligibleWorkIds[0] = "mutated";
  assert.deepEqual((await catalog.get("eval-history")).eligibleWorkIds, ["work-a"]);
  await assert.rejects(
    () => catalog.evaluate({ evaluationId: "eval-history", policy: policy() }),
    /already exists/i,
  );
  assert.equal((await evaluations.list({ policyId: "fleet-default" })).length, 1);
});

test("explicit selection rejects duplicate, unknown and non-pending work", async () => {
  const { catalog } = await fixture([
    work("pending", "runtime-a", "reassess", "2026-09-27T09:00:00.000Z"),
    work("active", "runtime-b", "review", "2026-09-27T09:01:00.000Z", "in-progress"),
  ]);
  await assert.rejects(
    () => catalog.evaluate({ evaluationId: "dup", policy: policy(), workIds: ["pending", "pending"] }),
    /duplicate work/i,
  );
  await assert.rejects(
    () => catalog.evaluate({ evaluationId: "missing", policy: policy(), workIds: ["missing"] }),
    /unknown runtime fleet convergence work/i,
  );
  await assert.rejects(
    () => catalog.evaluate({ evaluationId: "active", policy: policy(), workIds: ["active"] }),
    /not queue-eligible/i,
  );
});

test("policy validation rejects invalid concurrency, dependencies and duplicate rules", () => {
  assert.throws(
    () => validateRuntimeFleetConvergenceQueuePolicy(policy({ maxConcurrentByAction: { reassess: -1 } })),
    /non-negative integer/i,
  );
  assert.throws(
    () => validateRuntimeFleetConvergenceQueuePolicy(policy({ dependencies: { reassess: ["reassess"] } })),
    /cannot depend on itself/i,
  );
  assert.throws(
    () => validateRuntimeFleetConvergenceQueuePolicy(policy({ eligibilityRules: ["x", "x"] })),
    /duplicate eligibility rules/i,
  );
});
