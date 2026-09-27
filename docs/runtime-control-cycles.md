# Runtime control cycles

M29 links the existing continuous-runtime capabilities into one governed control-loop pass without changing their authority boundaries.

A control cycle runs:

```text
M23 drift assessment
        ↓
M26 posture capture
        ↓
M28 posture policy response
        ↓
immutable M29 cycle record
```

The underlying assessment, posture snapshot and response records remain the authoritative evidence. M29 stores their exact identities and resulting outcomes so operators can audit which evidence belonged to one control-loop pass.

## Running a cycle

```ts
const cycles = new RuntimeControlCycleCatalog(
  cycleStore,
  driftCatalog,
  postureCatalog,
  postureResponses,
);

const cycle = await cycles.run({
  cycleId: "cycle-2026-09-27-001",
  runtimeId: "production",
  baselineId: "baseline-12",
  assessmentId: "assessment-13",
  snapshotId: "posture-13",
  responseId: "response-13",
  remediationPlanId: "remediation-13",
});
```

M29 passes the exact baseline to M23, passes the resulting assessment identity into M26, and then passes the resulting posture snapshot into M28.

Optional `remediationCaseId` and `remediationPlanId` are forwarded to M26/M28 respectively. M29 itself never starts a deployment or changes external state.

## Failure evidence

A cycle records the exact stage that failed:

```text
assessment
posture
response
```

For example, if drift assessment succeeds but posture capture fails, the cycle record contains the assessment outcome plus:

```text
status      = failed
failedStage = posture
error       = ...
```

The response stage is not invoked after an earlier stage fails.

This does not roll back immutable evidence already produced by an earlier stage. Instead, M29 records the orchestration failure so the history remains truthful.

## Identity guards

The control loop validates that:

- M26 returns the requested runtime id and exact M23 assessment id;
- M28 returns the requested runtime id and exact M26 posture snapshot id.

A provider returning inconsistent evidence is recorded as a failed cycle rather than silently linking unrelated records.

## Immutable history

`RuntimeControlCycleStore` is create-only. The reference `MemoryRuntimeControlCycleStore` returns detached copies, supports runtime/status filters and rejects duplicate cycle ids.

Completed records retain:

- runtime id;
- baseline, assessment, posture and response ids;
- drift outcome;
- posture state;
- response disposition;
- start/completion timestamps.

Failed records retain the evidence reached before failure together with the failed stage and error.
