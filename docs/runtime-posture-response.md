# Runtime posture policy and response

M28 evaluates the latest immutable M26 runtime-posture snapshot through ordered caller-supplied policies and records an immutable response decision.

The core package does not repair infrastructure directly. A policy may request governed remediation planning, but any actual repair still flows through the existing M24/M25 remediation and M17/M18 deployment machinery.

## Policy actions

Policies return one of:

```text
ignore
notify
remediate
review
```

The strongest action wins using:

```text
review > remediate > notify > ignore
```

Non-ignore actions require an explanatory message. Policy evidence uses the existing database-neutral deployment evidence structure.

```ts
const policies = new RuntimePosturePolicyRegistry()
  .register({
    id: "notify-on-warning",
    evaluate({ snapshot }) {
      return snapshot.state === "warning"
        ? { action: "notify", message: "Runtime verification is incomplete." }
        : { action: "ignore" };
    },
  })
  .register({
    id: "repair-drift",
    evaluate({ snapshot }) {
      return snapshot.state === "drifted"
        ? { action: "remediate", message: "Restore the verified runtime baseline." }
        : { action: "ignore" };
    },
  });
```

Policy exceptions and malformed results fail closed to `review`, while later policies still run.

## Latest-posture guard

A response can only be produced for the latest snapshot of a runtime. This prevents an operator or automation from starting a response from evidence that has already been superseded.

Because policy evaluation and remediation planning may be asynchronous, M28 rechecks the latest snapshot immediately before persisting the response. If a newer posture snapshot appears during evaluation, the response fails with a concurrency error.

## Governed remediation bridge

When the final action is `remediate`, the caller supplies an M24-compatible remediation planner and a new remediation-plan id:

```ts
const responses = new RuntimePostureResponseCatalog(
  postureSnapshots,
  responseStore,
  policies,
  remediationCatalog,
);

const response = await responses.evaluate({
  responseId: "response-42",
  snapshotId: "posture-42",
  remediationPlanId: "remediation-42",
});
```

M28 calls M24 using the posture snapshot's exact drift assessment. An executable M24 remediation plan is referenced from the response record, but M28 does not create or start a deployment.

If remediation was requested but no planner/id is supplied, or M24 does not return an executable remediation disposition, the framework adds an explicit `$framework` decision and falls back to `review`.

## Immutable response history

`RuntimePostureResponseStore` is create-only. The reference `MemoryRuntimePostureResponseStore` returns detached copies and rejects duplicate response ids.

Each record retains:

- runtime id;
- exact posture snapshot id/state;
- assessment id;
- ordered policy decisions and evidence;
- final disposition;
- optional M24 remediation-plan identity/disposition;
- creation timestamp.

This makes response policy decisions independently auditable without rewriting the posture, drift evidence, remediation plan or deployment history.
