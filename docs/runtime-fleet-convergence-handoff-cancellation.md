# M43 — Handoff cancellation fences

M43 closes the stale-worker race that remains after M42 introduces non-expiring handoff locks.

## Problem

M42 promotes an `active` reservation to `handoff` before M40 admission. That prevents the finite M41 lease from expiring while M40/M36 work is in flight.

However, a handoff may still need to be abandoned explicitly when the owning process is believed to be dead. Releasing the M42 record by itself is not sufficient: the old process might wake up after release and still attempt the original M40 admission.

## Cancellation fence

M43 extends M40 with a terminal `cancelled` admission state.

A cancellation uses the **same immutable `admissionId`** that the stale worker would later use for dispatch.

```text
M42 handoff
    │
    ├── normal M40 admission wins ──► admitted/completed/failed
    │
    └── cancellation wins ──────────► cancelled
```

Both paths compete for `RuntimeFleetFairDispatchStore.create()` on the same ID. Store uniqueness is therefore the fence:

- if normal M40 admission wins first, cancellation fails;
- if cancellation wins first, every later dispatch attempt for that ID fails before M36;
- neither path can overwrite the terminal winner.

## Safe handoff release

For `handoff` reservations, M41/M42 release now performs:

1. read the exact M40 admission ID;
2. if a normal admission already exists, reject release and require resume/recovery;
3. otherwise create or reconcile the M40 `cancelled` tombstone;
4. only after the cancellation fence exists, transition the reservation to `released`.

This ordering means ownership is never freed before the stale admission path has been fenced.

## Crash recovery

### Crash after cancellation, before reservation release

The reservation remains `handoff`, but M40 already contains the terminal `cancelled` record. A retry of `release()` reconciles that cancellation and can safely finish the reservation release.

`resume()` also recognizes a cancelled M40 admission and resolves the reservation to `released` rather than treating the cancelled admission as executed work.

### Crash before cancellation wins

If normal M40 admission appears first, the cancellation attempt fails. The handoff remains owned and the caller must resume the existing dispatch path.

## M40 cancellation API

`RuntimeFleetFairDispatcher.cancel()` accepts the same immutable handoff identity as `dispatch()` plus a reason:

- `admissionId`
- `fairnessId`
- `dispatchId`
- `workerId`
- `maxItems`
- `reason`

It writes a terminal record with:

```text
status = cancelled
reason = <caller reason>
finishedAt = cancellation time
```

A repeated cancellation for the same identity is idempotent. A cancellation request that reuses the ID with a different fairness/dispatch/worker identity fails closed.

## Boundaries

M43 does not cancel work that already reached M36. If an M36 dispatch exists or M40 is already admitted/completed/failed, the cancellation fence cannot be created.

M43 remains database-neutral. Durable adapters must preserve atomic uniqueness for M40 admission creation so the cancellation-vs-dispatch race has one authoritative winner.