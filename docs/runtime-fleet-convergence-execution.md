# M35 — Runtime Fleet Convergence Execution

M35 executes durable M34 convergence work through pluggable action executors while preserving the existing governance boundaries around M16 profile upgrades, M24 drift remediation and M29 runtime control cycles.

## Responsibilities

M35 provides:

- an executor registry keyed by M34 convergence action;
- keyed and reconciled idempotency contracts;
- a durable execution-attempt store;
- stable idempotency keys across retries;
- executor evidence and external references;
- pre-execution M31 revision validation through the M34 claim;
- an additional post-claim revision race check before side effects;
- post-execution target-revision and desired-profile validation;
- fail-closed handling of executor exceptions and stale target state;
- explicit recovery of interrupted in-progress work.

M35 does **not** change M31 desired state and does not bypass the governed M16, M24 or M29 APIs. An executor is expected to call those APIs when its action requires them.

## Executor contract

An executor declares one or more M34 actions and one idempotency mode:

- `keyed` — `execute()` may be safely replayed with the same `idempotencyKey`;
- `reconciled` — interrupted execution must call `reconcile()` before M35 decides whether to retry or confirm completion.

Each completed/failed executor result includes the M31 target revision it observed after its governed operation. M35 re-reads M31 before finalizing the M34 work item and rejects a mismatched revision or changed desired profile.

## Durable execution attempts

`RuntimeFleetConvergenceExecutionRecord` records:

- work/runtime/action identity;
- attempt number;
- executor ID;
- stable idempotency key;
- desired-profile snapshot;
- M31 revision before execution;
- M31 revision after a certain result;
- status, summary/error and uncertainty;
- structured evidence/external reference;
- start/finish timestamps.

The reference `MemoryRuntimeFleetConvergenceExecutionStore` uses optimistic revisions, detached reads and immutable terminal attempts.

## Failure semantics

Executor exceptions are treated as uncertain failures because the external side effect may have completed before the exception reached M35. Such records deliberately omit `targetRevisionAfter` rather than inventing certainty.

Explicit executor failures are certain only after M35 validates the executor-reported target revision against the latest M31 runtime target.

If the desired profile changes while an execution is running, M35 fails closed and requires a fresh M33/M34 reconciliation path.

## Recovery

`RuntimeFleetConvergenceRunner.resume()` handles interrupted in-progress M34 work:

- keyed executors replay the existing running attempt with the original idempotency key;
- reconciled executors call `reconcile()` first;
- reconciliation may confirm completion, authorize replay, or remain `unknown`;
- executor replacement/mismatch is blocked;
- stale desired state is blocked.

`retry()` creates a new execution attempt for failed work while retaining the same stable idempotency key. Uncertain failures from reconciled executors remain blocked until explicitly reconciled rather than being replayed blindly.

## Governance chain

```text
M31 runtime target
       ↓
M33 reconciliation
       ↓
M34 durable work item
       ↓
M35 executor registry / attempt record
       ↓
M16 / M24 / M29 governed capability
       ↓
M31 target revalidation
       ↓
M34 completion or failure
```
