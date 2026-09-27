# M40 — Runtime Fleet Fairness-Bound Dispatch

M40 binds one immutable M39 fairness ordering to one exact M36 dispatch.

It turns M39 from an advisory ranking artifact into durable dispatch provenance without moving safety authority away from M37/M38-era revision guards.

## Chain

```text
M34 durable convergence work
  ↓
M37 safety/backpressure eligibility
  ↓
M39 fairness/starvation ordering
  ↓
M40 exact admission
  ↓
M36 bounded fleet dispatch
  ↓
M35 executors
```

## Admission rules

Before an admission is persisted, every selected M39 item must still:

- exist in M34
- remain `pending`
- have the exact revision captured by M39
- retain the same runtime identity
- retain the same action

The selected work is taken directly from `orderedWorkIds`; `maxItems` may truncate that order but cannot re-sort it.

Any stale item rejects the entire admission before M36 is invoked.

## Durable provenance

`RuntimeFleetFairDispatchRecord` stores:

- M39 fairness evaluation ID
- fairness policy ID/version
- source M37 evaluation ID and policy version
- exact M36 dispatch ID
- worker identity
- ordered admitted work
- M39 rank per item
- M39 effective priority per item
- starvation flag per item
- exact evaluated work revision
- final M36 outcome

The reference `MemoryRuntimeFleetFairDispatchStore` uses optimistic revisions and makes the selection/provenance immutable after creation.

## Crash-safe handoff

The admission is persisted before M36 is invoked.

If the process stops after M36 creates its dispatch record but before M40 records completion, `resume()` retrieves the existing M36 record and finalizes the admission without dispatching a second time.

If no M36 record exists, `resume()` invokes the original admitted dispatch ID, worker, and ordered work selection.

## Order integrity

When finalizing, M40 requires the M36 dispatch to contain the same work IDs in the same order as the M39 admission.

A mismatched dispatch is rejected. This prevents the fairness decision from being silently lost during orchestration.

## Boundaries

M40 does not:

- reevaluate M37 policy
- recompute M39 fairness
- claim M34 work itself
- execute M35 directly
- mutate M31 desired state
- schedule itself
- retry or recover individual convergence executors

Those responsibilities remain with their existing layers.