import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryRuntimeDeploymentStore,
  RuntimeDeploymentCatalog,
  RuntimeDeploymentExecutorRegistry,
  RuntimeDeploymentPolicyGate,
  RuntimeDeploymentPolicyRegistry,
  RuntimeDeploymentRunner,
} from "../dist/index.js";

function makePlan({ manualReview = false, stepCount = 1 } = {}) {
  const steps = Array.from({ length: stepCount }, (_, index) => ({
    id: `${String(index + 1).padStart(3, "0")}:upgrade-module:module-${index + 1}`,
    kind: "upgrade-module",
    moduleId: `module-${index + 1}`,
    fromVersion: 1,
    toVersion: 2,
    blocking: manualReview && index === 0,
    requiresManualReview: manualReview && index === 0,
    description: `Upgrade module ${index + 1}`,
  }));
  return {
    format: "nublox-metaobject-runtime-profile-upgrade",
    formatVersion: 1,
    profileId: "production",
    fromProfileVersion: 1,
    toProfileVersion: 2,
    impact: manualReview ? "breaking" : "compatible",
    requiresManualReview: manualReview,
    blockingStepCount: manualReview ? 1 : 0,
    moduleChanges: [],
    objectChanges: [],
    steps,
  };
}

function setup(plan = makePlan()) {
  const store = new MemoryRuntimeDeploymentStore();
  let tick = 0;
  const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));
  const planner = {
    async plan(profileId, fromProfileVersion, toProfileVersion) {
      return { ...structuredClone(plan), profileId, fromProfileVersion, toProfileVersion };
    },
  };
  const deployments = new RuntimeDeploymentCatalog(store, planner, clock);
  const executors = new RuntimeDeploymentExecutorRegistry().register({
    id: "test.executor",
    kinds: ["upgrade-module"],
    idempotency: "keyed",
    execute: async () => ({ status: "completed" }),
  });
  return { store, deployments, executors, clock };
}

function policyEvents(record) {
  return record.journal.filter((entry) => entry.kind === "deployment-policy-evaluated");
}

test("policy registry preserves order, rejects duplicates and fails closed", async () => {
  const registry = new RuntimeDeploymentPolicyRegistry()
    .register({ id: "allow", evaluate: () => ({ outcome: "allow" }) })
    .register({ id: "warn", evaluate: () => ({ outcome: "warn", message: "Proceed with caution" }) })
    .register({ id: "throws", evaluate: () => { throw new Error("policy backend offline"); } })
    .register({ id: "invalid", evaluate: () => ({ outcome: "warn" }) });

  assert.throws(
    () => registry.register({ id: "allow", evaluate: () => ({ outcome: "allow" }) }),
    /already registered/i,
  );

  const deployment = {
    deploymentId: "policy-order",
    status: "planned",
    revision: 1,
    profileId: "production",
    fromProfileVersion: 1,
    toProfileVersion: 2,
    plan: makePlan(),
    steps: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const report = await registry.evaluate(deployment);

  assert.deepEqual(report.evaluations.map((evaluation) => evaluation.policyId), ["allow", "warn", "throws", "invalid"]);
  assert.equal(report.allowed, false);
  assert.equal(report.hasWarnings, true);
  assert.match(report.evaluations[2].message, /policy backend offline/i);
  assert.match(report.evaluations[3].message, /warn result requires a message/i);
});

test("policy gate journals allow, warning and denial atomically", async () => {
  const { store, deployments, clock } = setup();
  const registry = new RuntimeDeploymentPolicyRegistry()
    .register({
      id: "change-window",
      evaluate: () => ({
        outcome: "allow",
        evidence: { externalReference: "window:2026-01", details: { open: true } },
      }),
    })
    .register({ id: "capacity", evaluate: () => ({ outcome: "warn", message: "Capacity is close to threshold" }) })
    .register({ id: "approval-ticket", evaluate: () => ({ outcome: "deny", message: "CAB approval missing" }) });
  const gate = new RuntimeDeploymentPolicyGate(store, registry, clock);
  const created = await deployments.create("policy-journal", "production", 1, 2);

  const result = await gate.evaluate(created);
  assert.equal(result.report.allowed, false);
  assert.equal(result.report.hasWarnings, true);
  assert.equal(result.record.status, "planned");
  assert.equal(result.record.revision, created.revision + 1);

  const events = policyEvents(result.record);
  assert.deepEqual(events.map((entry) => entry.policyOutcome), ["allow", "warn", "deny"]);
  assert.deepEqual(events.map((entry) => entry.policyId), ["change-window", "capacity", "approval-ticket"]);
  assert.equal(events[0].evidence.externalReference, "window:2026-01");
  assert.deepEqual(events[0].evidence.details, { open: true });
  assert.equal(events[2].message, "CAB approval missing");
});

test("runner blocks a denied policy before deployment start or step lease", async () => {
  const { store, deployments, executors, clock } = setup();
  let executions = 0;
  const countingExecutors = new RuntimeDeploymentExecutorRegistry().register({
    id: "counting",
    kinds: ["upgrade-module"],
    idempotency: "keyed",
    execute: async () => {
      executions += 1;
      return { status: "completed" };
    },
  });
  const policies = new RuntimeDeploymentPolicyRegistry().register({
    id: "freeze",
    evaluate: () => ({ outcome: "deny", message: "Change freeze active" }),
  });
  const gate = new RuntimeDeploymentPolicyGate(store, policies, clock);
  const runner = new RuntimeDeploymentRunner(deployments, countingExecutors, clock, undefined, gate);
  await deployments.create("policy-denied", "production", 1, 2);

  const result = await runner.run("policy-denied");
  assert.equal(result.blockedReason, "policy-denied");
  assert.equal(result.record.status, "planned");
  assert.equal(result.record.steps[0].status, "pending");
  assert.equal(result.record.steps[0].attempts, 0);
  assert.equal(executions, 0);
  assert.deepEqual(result.record.journal.map((entry) => entry.kind), [
    "deployment-created",
    "deployment-policy-evaluated",
  ]);
});

test("allow and warning policies are journalled before deployment start and execution", async () => {
  const { store, deployments, executors, clock } = setup();
  const policies = new RuntimeDeploymentPolicyRegistry()
    .register({ id: "health", evaluate: () => ({ outcome: "allow" }) })
    .register({ id: "notice", evaluate: () => ({ outcome: "warn", message: "Minor replication lag" }) });
  const gate = new RuntimeDeploymentPolicyGate(store, policies, clock);
  const runner = new RuntimeDeploymentRunner(deployments, executors, clock, undefined, gate);
  await deployments.create("policy-allowed", "production", 1, 2);

  const result = await runner.run("policy-allowed");
  assert.equal(result.record.status, "completed");
  assert.equal(result.executedSteps, 1);
  assert.deepEqual(result.record.journal.slice(0, 4).map((entry) => entry.kind), [
    "deployment-created",
    "deployment-policy-evaluated",
    "deployment-policy-evaluated",
    "deployment-started",
  ]);
  assert.deepEqual(policyEvents(result.record).map((entry) => entry.policyOutcome), ["allow", "warn"]);
});

test("a denied planned deployment can be re-evaluated later without losing the earlier decision", async () => {
  const { store, deployments, executors, clock } = setup();
  let freeze = true;
  const policies = new RuntimeDeploymentPolicyRegistry().register({
    id: "dynamic-freeze",
    evaluate: () => freeze
      ? { outcome: "deny", message: "Freeze still active" }
      : { outcome: "allow", message: "Freeze lifted" },
  });
  const gate = new RuntimeDeploymentPolicyGate(store, policies, clock);
  const runner = new RuntimeDeploymentRunner(deployments, executors, clock, undefined, gate);
  await deployments.create("policy-recheck", "production", 1, 2);

  let result = await runner.run("policy-recheck");
  assert.equal(result.blockedReason, "policy-denied");
  assert.equal(result.record.status, "planned");
  freeze = false;

  result = await runner.run("policy-recheck");
  assert.equal(result.record.status, "completed");
  const decisions = policyEvents(result.record);
  assert.deepEqual(decisions.map((entry) => entry.policyOutcome), ["deny", "allow"]);
  assert.equal(decisions[0].message, "Freeze still active");
  assert.equal(decisions[1].message, "Freeze lifted");
});

test("manual review and autoStart guards run before policy evaluation", async () => {
  const reviewed = setup(makePlan({ manualReview: true }));
  let evaluations = 0;
  const policies = new RuntimeDeploymentPolicyRegistry().register({
    id: "counter",
    evaluate: () => {
      evaluations += 1;
      return { outcome: "allow" };
    },
  });
  const gate = new RuntimeDeploymentPolicyGate(reviewed.store, policies, reviewed.clock);
  const runner = new RuntimeDeploymentRunner(reviewed.deployments, reviewed.executors, reviewed.clock, undefined, gate);
  const created = await reviewed.deployments.create("policy-manual", "production", 1, 2);

  let result = await runner.run(created.deploymentId);
  assert.equal(result.blockedReason, "approval-required");
  assert.equal(evaluations, 0);

  const approved = await reviewed.deployments.approve(created.deploymentId, result.record.revision);
  result = await runner.run(approved.deploymentId, { autoStart: false });
  assert.equal(result.blockedReason, "not-started");
  assert.equal(evaluations, 0);

  result = await runner.run(approved.deploymentId);
  assert.equal(result.record.status, "completed");
  assert.equal(evaluations, 1);
});

test("runner without a policy gate retains M18 behavior", async () => {
  const { deployments, executors, clock } = setup();
  await deployments.create("policy-none", "production", 1, 2);
  const runner = new RuntimeDeploymentRunner(deployments, executors, clock);

  const result = await runner.run("policy-none");
  assert.equal(result.record.status, "completed");
  assert.equal(policyEvents(result.record).length, 0);
});
