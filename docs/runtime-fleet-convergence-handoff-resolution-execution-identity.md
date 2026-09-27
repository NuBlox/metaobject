# M47 — Resolution Execution Identity Hardening

M47 strengthens M46 crash reconciliation by freezing the complete immutable M42 handoff identity inside every new execution receipt.

M46 already persisted the reservation revision and M40 admission snapshot before invoking M45. For terminal lost-response recovery, however, a reservation with the same reservation/admission IDs could previously be accepted without independently proving its complete immutable handoff identity. M47 closes that gap.

## Captured identity

New M46 execution receipts now include `handoffIdentity`:

- `dispatchId`
- `workerId`
- `handoffAt`
- exact ordered work set:
  - `workId`
  - `runtimeId`
  - action
  - work revision
  - fairness rank

The identity is immutable for the life of the execution receipt.

## Terminal reconciliation

Before a lost response can be reconciled as `completed`, M47 now proves that the terminal M41/M42 reservation still has the exact identity that started M46.

```text
expected terminal status
        +
reservation/admission IDs
        +
dispatch ID
        +
worker ID
        +
handoff timestamp
        +
ordered work identity
        +
advanced reservation revision
        ↓
completed
```

If the reservation reached the expected terminal status but any immutable identity field differs, the receipt becomes `uncertain` rather than being treated as a successful execution.

That forces a fresh M44/M45 decision instead of guessing whether the observed terminal record belongs to the execution that originally started.

## Normal execution

The same identity check is applied to the reservation returned by a successful M45 execution before M46 records `completed`.

## Start-snapshot retry

When `resume()` considers retrying a still-running M46 execution, the full handoff identity must also match. A modified ordered work set therefore cannot be treated as an unchanged safe-retry state merely because the reservation revision was unchanged.

## Compatibility

`handoffIdentity` is optional in the format so persisted `0.46.x` receipts remain readable and recoverable.

- legacy receipts without `handoffIdentity` retain the M46 validation behavior;
- every new `0.47.x` receipt created by `RuntimeFleetHandoffResolutionExecutionCatalog.run()` includes the full identity;
- the in-memory store prevents the identity from being changed after receipt creation.

A future persisted-store migration can backfill or explicitly mark legacy receipts if an application needs the stronger proof for historical records.

## Boundary

M47 does not add cryptographic signatures, persistence drivers, authentication, schedulers or application-specific runtime concepts. It hardens the generic execution-evidence contract while remaining database-neutral.
