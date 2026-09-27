# M45 — Manual Handoff Recovery Resolution

M45 closes the manual-review loop introduced by M44.

M44 can classify an M42 handoff as `review` when the evidence is too old to resume automatically but not old enough to cancel automatically. M45 allows a caller or operator to turn that review decision into an explicit, attributable `resume` or `cancel` choice without bypassing the existing M42/M43 fencing guarantees.

## Resolution record

`RuntimeFleetHandoffRecoveryResolutionRecord` is immutable, create-only evidence containing:

- resolution ID
- source M44 recovery audit ID
- reservation ID and exact M42 revision
- admission ID and dispatch ID
- worker ID
- exact `handoffAt`
- selected action: `resume` or `cancel`
- actor ID
- reason
- exact M40 status/revision when the M44 audit observed one
- resolution timestamp

The reference store is `MemoryRuntimeFleetHandoffRecoveryResolutionStore`.

## Resolve

A resolution may only be created for an M44 decision whose action is `review`.

```ts
const resolution = await resolutions.resolve({
  resolutionId: "resolution-42",
  recoveryId: "recovery-2026-09-27T12:00Z",
  reservationId: "reservation-42",
  action: "resume",
  actorId: "operator-17",
  reason: "External system confirms the original operation never started.",
});
```

Before persisting the resolution, M45 revalidates the exact M42 reservation and M40 admission evidence captured by M44. If either changed, the resolution is rejected and a fresh M44 audit is required.

## Execute

Execution is a separate explicit call:

```ts
await resolutions.execute(resolution.resolutionId);
```

M45 revalidates the frozen reservation/admission snapshot again immediately before execution.

The selected action then routes through the existing governed layers:

```text
resume
  -> M41/M42 resume()
  -> M40/M36 reconciliation or execution

cancel
  -> M41/M42 release()
  -> M43 M40 cancellation fence
  -> safe release
```

M45 never edits M40/M41/M42 records directly.

## Fail-closed fencing

A resolution is not a permanent permission to act. If, after resolution creation:

- the M42 reservation revision changes;
- the handoff identity changes;
- the reservation leaves `handoff` state;
- an M40 admission appears when none existed;
- an existing M40 status or revision changes;

then `execute()` fails closed. A new M44 audit and, when required, a new M45 resolution must be produced.

This prevents a delayed operator action from overriding newer distributed-system evidence.

## Attribution and history

The create-only resolution store preserves `actorId`, `reason`, action and the complete frozen fencing snapshot. History can be filtered by actor, action or recovery audit.

## Boundary

M45 is caller-triggered and database-neutral. It adds no approval UI, identity provider, scheduler, background worker, tenant model or database driver to `@nublox/metaobject`. Applications decide how `actorId` is authenticated and what authorization is required before calling `resolve()`.
