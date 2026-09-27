# M42 — Dispatch handoff locks

M42 closes the remaining expiry race between the finite M41 reservation lease and the longer-running M40/M36 dispatch handoff.

## Problem

M41 intentionally uses finite leases while work is waiting to be dispatched. That allows abandoned reservations to expire and stop blocking the fleet.

A finite lease is not appropriate once dispatch has actually started. M40 persists an admission before invoking M36, but there is still a narrow period between M41 validating the reserved work and M40 establishing that durable admission. If the M41 lease expires while an orchestrator is blocked or slow in that handoff, another caller could otherwise reserve the same M34 work.

## State model

M42 extends the M41 reservation lifecycle:

```text
active
  │
  ├── release ───────────────► released
  │
  └── begin dispatch
          │
          ▼
       handoff
          │
          ├── explicit release, only before M40 admission ─► released
          │
          └── exact M40/M36 result ────────────────────────► consumed
```

`active` remains a finite lease governed by `expiresAt`.

`handoff` is a non-expiring ownership lock. `expiresAt` remains historical provenance but no longer determines exclusivity after `handoffAt` is recorded.

## Atomic exclusivity

A `RuntimeFleetFairReservationStore` must atomically reject overlapping work when:

- another `active` reservation is still unexpired; or
- another reservation is in `handoff`, regardless of its original `expiresAt`.

The `active -> handoff` transition must repeat the overlap check atomically. This matters when recovering a legacy or expired active record: if a newer reservation acquired the work after the old lease expired, the old reservation cannot reclaim it as a non-expiring handoff lock.

The reference `MemoryRuntimeFleetFairReservationStore` implements these guarantees.

## Dispatch sequence

For a normal M42-aware dispatch:

```text
M39 fairness
    ↓
M41 active reservation
    ↓
lease still valid + M34 work revalidated
    ↓
atomic active → handoff
    ↓
M40 fairness-bound admission
    ↓
M36 dispatch
    ↓
M35 execution
    ↓
handoff → consumed
```

The key property is that the finite lease is replaced by the non-expiring handoff lock **before** M40 is invoked.

## Recovery

### Crash before M40 admission

If the process stops after the reservation entered `handoff` but before an M40 admission was created, `resume()` may continue even after the original `expiresAt` has passed. The handoff lock already owns the work and does not expire.

### Crash after M40 admission

If M40 admission evidence exists, `resume()` validates that the admission matches the reservation and delegates to M40 recovery. A completed M40 result consumes the reservation.

### Concurrent recovery

If two callers attempt to continue the same handoff, the M40 admission ID remains stable. M40's durable admission and M41 optimistic revisions prevent the handoff from being consumed twice. If another caller already completed the same reservation, the later caller accepts the matching consumed record.

## Explicit release

An operator/caller may explicitly release either an `active` or `handoff` reservation only while no M40 admission exists.

This is safe because M40 persists its admission before M36 external execution. Once M40 admission exists, release is rejected and callers must use recovery/resume instead.

## Compatibility

Existing M41 records remain valid:

- historical `active`, `consumed`, and `released` records are unchanged;
- `handoffAt` is optional for historical terminal records;
- new dispatches use `active -> handoff -> consumed`;
- legacy active records with existing M40 evidence are promoted to handoff during recovery, subject to the atomic overlap check.

## Boundaries

M42 remains database-neutral. It does not:

- schedule dispatches;
- renew active leases automatically;
- execute M35 directly;
- alter M39 fairness ordering;
- bypass M40 admission or M36 dispatch;
- mutate M31 desired state.

Durable database adapters must preserve the atomic overlap and optimistic transition semantics defined by `RuntimeFleetFairReservationStore`.