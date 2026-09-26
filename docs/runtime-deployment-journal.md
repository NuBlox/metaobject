# Immutable runtime deployment journal

M19 adds an append-only audit journal to the durable M17/M18 deployment record.

The journal is intentionally part of the same optimistic deployment save as the state mutation that caused the event. This means a transition cannot commit successfully while its audit event is lost.

## Why the journal lives with the deployment contract

A separate best-effort event sink would create a failure window:

```text
state saved
    ↓
process crashes
    ↓
journal append never happens
```

M19 instead commits:

```text
new deployment state
        +
new journal entry
        ↓
one optimistic store save
```

A database adapter may physically normalize journal entries into another table, but it must commit the deployment state and journal row in the same transaction.

## Journal entry

Each event has a 1-based deployment-local sequence:

```ts
interface RuntimeDeploymentJournalEntry {
  sequence: number;
  kind: RuntimeDeploymentJournalKind;
  occurredAt: string;
  stepId?: string;
  attempt?: number;
  executorId?: string;
  idempotencyKey?: string;
  error?: string;
  recoveryResolution?: "retry" | "completed" | "unknown";
  evidence?: RuntimeDeploymentStepEvidence;
}
```

The sequence is append-only and continuous:

```text
1, 2, 3, 4, ...
```

`validateRuntimeDeploymentJournal()` rejects gaps, reordered sequence numbers and malformed event fields.

## Recorded events

M19 records:

```text
deployment-created
deployment-approved
deployment-started
deployment-cancelled
deployment-completed
step-leased
step-completed
step-failed
step-retry-requested
step-recovered-completed
step-reconciliation-unknown
```

This is deliberately more detailed than the current mutable step state.

For example, after a failure and retry the current state may only show:

```text
status    completed
attempts  2
```

while the journal preserves:

```text
step-leased attempt=1
step-failed attempt=1 error="service unavailable"
step-retry-requested attempt=1
step-leased attempt=2
step-completed attempt=2
```

## M18 executor evidence

M18 executor identity, idempotency keys and evidence are copied into relevant journal events.

A completed external migration can therefore leave an immutable record such as:

```text
kind              step-completed
stepId            004:migrate-object-type:invoice
attempt           2
executorId        mysql.schema
idempotencyKey    release-42:004:migrate-object-type:invoice
externalReference migration:8472
```

The current step state may later be transformed by recovery, but the previous journal entry remains intact.

## Reconciliation

A reconciled M18 executor can return `unknown` when it cannot prove whether an external side effect happened.

M19 records that decision as:

```text
step-reconciliation-unknown
```

without changing the step from `running`/`failed`.

A later explicit or automated recovery adds another event:

```text
step-retry-requested
```

or:

```text
step-recovered-completed
```

The complete decision history is therefore retained.

## Reading the journal

```ts
const entries = await deployments.journal(deploymentId);
```

The returned list is a detached clone. Mutating it cannot change the stored journal.

## Backwards compatibility

`RuntimeDeploymentRecord.journal` is optional at the type level so records written by M17/M18 stores can still be read.

All deployments created through the M19 `RuntimeDeploymentCatalog` receive a journal immediately. The next state transition on a legacy record starts journalling from sequence 1.

## Store validation

`MemoryRuntimeDeploymentStore` validates the journal before each save.

Production adapters should call the same validation logic before persistence and additionally enforce sequence uniqueness transactionally, for example with a physical key such as:

```text
(deployment_id, sequence)
```

## Physical relational mapping

A SQL adapter may map the embedded contract to:

```text
runtime_deployment
    deployment_id
    ...

runtime_deployment_step
    deployment_id
    step_id
    ...

runtime_deployment_journal
    deployment_id
    sequence
    kind
    occurred_at
    step_id
    attempt
    executor_id
    idempotency_key
    error
    recovery_resolution
    evidence_json
```

The physical representation is adapter-specific; the semantic journal contract remains in `@nublox/metaobject`.
