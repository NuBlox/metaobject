# Persistent runtime deployments

M17 turns an M16 runtime-profile upgrade plan into durable, recoverable execution state.

The core still does not execute database DDL, data conversion or other external side effects. Instead it persists exactly what should run, what has started, what completed, and where operator intervention is required.

## Create a deployment

```ts
const deployments = new RuntimeDeploymentCatalog(
  deploymentStore,
  runtimeProfileUpgradePlanner,
);

const deployment = await deployments.create(
  "release-2026-09-26",
  "production",
  3,
  4,
);
```

Creation calls the M16 planner and stores an immutable snapshot of the resulting upgrade plan. Later changes to metadata, profiles or planning code therefore cannot silently alter an in-progress deployment.

## Lifecycle

```text
                    ┌──────────────┐
                    │   planned    │
                    └──────┬───────┘
                           │ start
                 approval │ when required
                           ▼
                    ┌──────────────┐
                    │   running    │
                    └───┬──────┬───┘
                        │      │
                 failure│      │ all steps complete
                        ▼      ▼
                 ┌─────────┐  ┌──────────────┐
                 │ failed  │  │  completed   │
                 └────┬────┘  └──────────────┘
                      │ explicit recovery
                      └──────► running/completed

planned ── cancel ──► cancelled
```

Cancellation is intentionally limited to `planned`. Once external execution has started, partial side effects must be recovered explicitly rather than being hidden behind a cancelled status.

## Manual approval

If the M16 plan contains manual-review steps, `start()` is blocked until `approve()` records an explicit approval timestamp.

```ts
let record = await deployments.approve(id, record.revision);
record = await deployments.start(id, record.revision);
```

Approval and every other state transition use optimistic revisions, allowing database-backed stores to reject competing deployment controllers deterministically.

## Durable step leasing

Before an external executor starts work, it calls:

```ts
const lease = await deployments.beginNextStep(
  deploymentId,
  deployment.revision,
);
```

M17 first persists the selected step as `running` and increments its attempt count. Only then is the step returned to the caller for execution.

This ordering is deliberate:

```text
persist RUNNING
      ↓
return step lease
      ↓
perform external side effect
      ↓
completeStep / failStep
```

A crash between the external side effect and `completeStep()` therefore leaves visible evidence that execution may already have occurred.

## Interrupted-step recovery

A persisted `running` step blocks acquisition of another step. After a restart, the operator/executor must decide what happened externally:

```ts
await deployments.recoverStep(
  deploymentId,
  stepId,
  revision,
  "retry",
);
```

or:

```ts
await deployments.recoverStep(
  deploymentId,
  stepId,
  revision,
  "completed",
);
```

`retry` returns the step to `pending` while preserving its attempt count. The next lease increments that count again.

`completed` confirms that the external side effect already succeeded and records completion without executing the operation again.

This is safer than automatic retry for non-idempotent migrations, DDL or integrations.

## Failure handling

An executor reports a known failure with:

```ts
await deployments.failStep(
  deploymentId,
  stepId,
  revision,
  "database unavailable",
);
```

The deployment enters `failed`, and the error text remains attached to the step. Recovery is then explicit: retry it or confirm it completed despite the reported process failure.

## Store contract

`RuntimeDeploymentStore` is database-neutral:

```ts
interface RuntimeDeploymentStore {
  get(deploymentId: string): Promise<RuntimeDeploymentRecord | null>;
  list(filter?: RuntimeDeploymentRecordFilter): Promise<readonly RuntimeDeploymentRecord[]>;
  save(record: RuntimeDeploymentRecord, expectedRevision?: number): Promise<RuntimeDeploymentRecord>;
  delete(deploymentId: string, expectedRevision: number): Promise<void>;
}
```

`MemoryRuntimeDeploymentStore` is the reference implementation. SQL adapters should persist records transactionally and enforce optimistic revision checks.

## Step state

Every M16 plan step has corresponding durable execution state:

```text
pending -> running -> completed
             │
             └────► failed

running/failed -> pending   (explicit retry)
running/failed -> completed (explicit confirmation)
```

Attempt counters, start/completion timestamps and the latest error are persisted with the deployment.

## Responsibility boundary

The architecture now separates four concerns:

```text
M14 exact runtime profile
          ↓
M16 deterministic upgrade plan
          ↓
M17 durable execution state
          ↓
application / adapter executor
          ↓
DDL, data migration, integrations, rollout
```

M17 intentionally does not know about NuBlox tenants, cloud environments, deployment rings or a specific database. Higher-level products can attach those concepts to a deployment id while the core state machine remains reusable and deterministic.
