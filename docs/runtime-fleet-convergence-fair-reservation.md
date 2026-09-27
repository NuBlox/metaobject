# M41 — Runtime Fleet Fair-Dispatch Reservation Leases

M41 closes the concurrency window between M39/M40 preflight and the point where M36/M35 actually claims convergence work.

Without a reservation layer, two independent callers could both observe the same M34 work as `pending`, both pass fairness/admission validation, and race toward dispatch. M34/M35 would eventually stop one of them, but both orchestration paths could still persist apparently valid admission intent.

M41 introduces an atomic logical lease over the exact M39-ranked work set before M40 admission.

## Chain

```text
M34 durable convergence work
  ↓
M37 safety/backpressure evaluation
  ↓
M39 fairness ordering
  ↓
M41 atomic reservation lease
  ↓
M40 fairness-bound admission
  ↓
M36 fleet dispatch
  ↓
M35 executors
```

## Atomic acquisition

`RuntimeFleetFairReservationStore.acquire()` has an explicit atomicity contract:

> Reject acquisition when any requested work ID is already held by an unexpired active reservation.

The reference `MemoryRuntimeFleetFairReservationStore` implements that rule in one synchronous in-memory critical section. Persistent adapters must preserve the same semantic guarantee using their native transactional/locking facilities.

## Reservation provenance

A reservation freezes:

- reservation ID
- M39 fairness evaluation ID
- fairness policy ID/version
- source M37 evaluation ID
- intended M40 admission ID
- intended M36 dispatch ID
- worker identity
- exact ordered work IDs
- exact M34 work revisions
- M39 fairness ranks
- acquisition time
- lease expiry

These fields cannot be changed after acquisition.

## Lease expiry

Expired active reservations remain historical records but no longer block later acquisitions.

The store does not rewrite an expired reservation merely because time passed. Expiry is evaluated when a new acquisition is attempted or when a caller tries to start work from the old reservation.

This keeps history append/transition based instead of introducing hidden timer-driven mutation.

## Dispatch

Before M40 is invoked, M41 checks that every leased M34 item still:

- exists
- remains `pending`
- has the exact leased revision
- retains the same runtime identity
- retains the same action

The reservation must also still be within its lease window unless an M40 admission already exists.

After M40 reaches terminal state, the reservation becomes `consumed` and records:

- M40 admission status
- final M36 dispatch outcome when applicable
- terminal timestamp
- M40 failure reason when applicable

## Crash recovery

There are two recovery cases.

### No M40 admission exists

The lease must still be unexpired. `resume()` re-enters the normal dispatch path using the reservation's immutable admission ID, dispatch ID, worker and work selection.

### M40 admission already exists

`resume()` is allowed even after the lease expires. At that point the handoff has already occurred, so recovery must reconcile and consume the reservation instead of abandoning evidence because a timer elapsed.

## Release

An active reservation may be explicitly released before M40 admission exists.

Release requires:

- optimistic reservation revision
- non-empty reason
- no existing M40 admission for the reservation

Released reservations are terminal and immutable. Their work immediately becomes available to future acquisitions.

## Boundaries

M41 does not:

- evaluate M37 safety policy
- compute M39 fairness
- mutate M31 desired state
- execute convergence actions
- schedule itself
- automatically renew leases
- delete expired reservation history

It is a database-neutral concurrency contract. A future persistent adapter can implement atomic acquisition with database transactions, unique/locking tables, compare-and-set semantics, or equivalent mechanisms while keeping the core package independent of a specific datastore.