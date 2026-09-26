# Runtime deployment execution

M18 adds a database-neutral execution framework on top of M17 durable deployment state.

M17 deliberately stopped at leasing and recording steps. M18 supplies the missing coordination layer: resolve an executor for a plan step, persist the executor identity and idempotency token before side effects begin, invoke the executor, capture evidence, and advance the deployment safely.

## Executor registry

Executors are registered by M16 upgrade-step kind:

```ts
const executors = new RuntimeDeploymentExecutorRegistry()
  .register({
    id: "mysql.schema",
    kinds: ["upgrade-module", "migrate-object-type"],
    idempotency: "keyed",
    async execute(context) {
      await applyChange(context.step, {
        idempotencyKey: context.idempotencyKey,
      });
      return {
        status: "completed",
        evidence: { externalReference: "migration:8472" },
      };
    },
  });
```

Only one executor can own a step kind in a registry. Duplicate executor ids, duplicate kinds and ambiguous kind ownership are rejected before deployment execution starts.

## Idempotency contracts

Every executor declares one of two recovery contracts.

### `keyed`

`execute()` must treat `context.idempotencyKey` as a deduplication token. Repeating the operation with the same token must be safe and must not create a second independent side effect.

This is appropriate for APIs, migration services or command processors that natively support idempotency keys.

### `reconciled`

A reconciled executor must implement `reconcile()`.

After an interrupted process leaves a step durably `running`, `reconcile()` inspects the external system and returns one of:

```text
completed  external effect definitely succeeded
retry      external effect definitely did not succeed
unknown    outcome still cannot be established safely
```

`unknown` never causes automatic replay.

## Durable executor identity

The first M18 lease stores:

```text
executorId
idempotencyKey
```

on the M17 step state before `execute()` is called.

Those values survive retries. A later runner cannot silently replace the executor or assign a different idempotency key to the same step.

The default key is deterministic:

```text
<deploymentId>:<stepId>
```

Applications can inject another key factory when required.

## Running a deployment

```ts
const runner = new RuntimeDeploymentRunner(
  deployments,
  executors,
);

const result = await runner.run("release-2026-09-26");
```

`run()`:

1. loads the durable M17 record;
2. auto-starts a planned deployment when approval requirements are satisfied;
3. checks for unresolved running/failed work;
4. resolves the executor **before** taking a lease;
5. persists the executor id and idempotency key with the lease;
6. invokes the executor;
7. records completion/failure evidence;
8. advances to the next step until complete or blocked.

`maxSteps` bounds how many external operations one invocation may perform:

```ts
await runner.run(id, { maxSteps: 10 });
```

This allows a scheduler or worker to process large plans in controlled batches.

## Blocking conditions

The runner returns without executing unsafe work when it encounters:

```text
approval-required
not-started
recovery-required
step-failed
missing-executor
executor-mismatch
reconciliation-unknown
max-steps
```

A missing executor is detected before a step is leased, so the deployment remains pending rather than creating an ambiguous in-flight operation.

## Executor result and evidence

Executors return either:

```ts
{ status: "completed", evidence?: ... }
```

or:

```ts
{ status: "failed", error: "...", evidence?: ... }
```

Thrown exceptions are converted into durable M17 step failures.

Evidence may contain:

```text
recordedAt          assigned by the runner
externalReference   migration/job/change identifier
details             structured adapter-specific evidence
```

Evidence is stored with the deployment step and is therefore available after restart for audit and reconciliation.

## Restart behaviour

Ordinary `run()` never guesses what happened to a surviving `running` step. It returns `recovery-required`.

Use:

```ts
await runner.resume(deploymentId);
```

### Keyed executor

M18 returns the uncertain step to pending and executes it again using the **same** persisted idempotency key. The executor's keyed contract makes the replay safe.

### Reconciled executor

M18 calls `reconcile()` first.

- `completed`: M17 is advanced without calling `execute()` again.
- `retry`: the step returns to pending and normal execution continues.
- `unknown`: execution remains blocked.

This provides automatic recovery only when the executor has supplied a contract strong enough to make it safe.

## Responsibility boundary

M18 remains independent of MySQL, cloud infrastructure and application-specific rollout concepts.

```text
M16 upgrade plan
      ↓
M17 durable deployment + lease
      ↓
M18 executor registry / runner
      ↓
adapter executor
      ↓
MySQL DDL / data transform / API / filesystem / external job
```

Database-specific packages should register executors for the step kinds they can perform. They should use the M18 idempotency token in their own transaction/job/idempotency mechanism and return external execution evidence.
