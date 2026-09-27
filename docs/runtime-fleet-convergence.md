# Runtime fleet convergence work

M34 turns immutable M33 reconciliation recommendations into durable coordination records for external orchestrators.

It does not execute profile upgrades, drift remediation, reassessment or review itself. Instead, it provides a revision-bound work item that an external worker can claim, complete, fail, retry or cancel while the existing governed M16/M24/M29 paths perform the actual work.

## Materialization

`RuntimeFleetConvergenceCatalog.materialize(runId)` reads one immutable M33 reconciliation run and creates work only for targets whose recommended action is not `none`.

Each work item stores:

- reconciliation run id;
- runtime id;
- exact M31 target revision observed by M33;
- recommended action;
- reason;
- lifecycle status;
- optimistic work revision;
- claim identity/timestamps when applicable.

The default work id is deterministic from reconciliation id, runtime id and action.

## Stale-work guard

Before a pending item can be claimed, M34 re-reads its M31 runtime target.

The claim is rejected when:

- the runtime no longer exists;
- the runtime is retired;
- the current M31 target revision differs from the revision captured by M33.

This prevents workers from acting on superseded desired/observed state.

## Work lifecycle

```text
pending
  | claim
  v
in-progress
  | complete       | fail
  v                v
completed        failed
                   |
                   | retry
                   v
                 pending

pending -- cancel --> cancelled
```

`completed`, `failed` and `cancelled` records retain the work identity and immutable reconciliation provenance. Failed items must explicitly return to `pending` before another worker can claim them.

## Atomic materialization

The store contract exposes `createMany()` so one reconciliation run is materialized atomically. The reference in-memory store validates the entire batch and all id conflicts before inserting any item.

## Boundary

M34 never:

- creates or changes M31 runtime targets;
- changes desired profiles;
- invokes M16 upgrade planning;
- invokes M24 remediation planning;
- runs M29 control cycles;
- executes external side effects.

Those responsibilities stay with existing governed components or adapter/application workers. M34 only coordinates which exact reconciliation recommendation is being acted upon.
