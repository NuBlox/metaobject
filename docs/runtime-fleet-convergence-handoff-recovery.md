# M44 — Handoff Recovery Policy and Fencing Audit

M44 turns M42/M43 handoff recovery into an explicit, auditable control-plane operation.

A handoff can outlive its original finite M41 reservation lease. M42 deliberately makes that ownership non-expiring once dispatch begins, and M43 provides a cancellation fence when the handoff must be abandoned. M44 adds the missing operational layer: determine what should happen to every outstanding handoff without requiring callers to inspect low-level reservation and admission records manually.

## Recovery actions

Every audited handoff receives exactly one recommendation:

- `resume` — continue or reconcile the existing M40/M36 path.
- `cancel` — create/reconcile the M43 cancellation fence and release the handoff.
- `review` — require an explicit operator/application decision; M44 performs no mutation.

M44 remains explicit. It does not schedule itself, poll in the background or execute every recommendation automatically.

## Policy

`RuntimeFleetHandoffRecoveryPolicyDefinition` is serializable and versioned:

```ts
const policy = {
  format: "nublox-metaobject-runtime-fleet-handoff-recovery-policy",
  formatVersion: 1,
  policyId: "default",
  version: 1,
  reviewAfterMs: 60_000,
  cancelAfterMs: 300_000,
} as const;
```

For handoffs with no M40 admission evidence:

```text
age < reviewAfterMs
        -> resume

reviewAfterMs <= age < cancelAfterMs
        -> review

age >= cancelAfterMs
        -> cancel
```

Existing M40 evidence takes precedence over age:

- `admitted`, `completed` or `failed` -> `resume` so existing evidence is reconciled.
- `cancelled` -> `cancel` so the already-created M43 fence is finalized into an M41/M42 release.

## Immutable audit evidence

`RuntimeFleetHandoffRecoveryCatalog.audit()` captures, for each handoff:

- reservation ID and exact M42 revision
- admission ID
- dispatch ID
- worker ID
- `handoffAt`
- observed handoff age
- selected recovery action and reason
- exact M40 status and revision, when present

Audits are persisted through the create-only `RuntimeFleetHandoffRecoveryStore`. The reference implementation is `MemoryRuntimeFleetHandoffRecoveryStore`.

## Explicit execution

`RuntimeFleetHandoffRecoveryCatalog.execute(recoveryId, reservationId)` executes one recorded decision only after re-reading current state.

Before any mutation it verifies that:

1. the reservation still exists and is still `handoff`;
2. its exact revision and immutable handoff identity still match the audit;
3. the M40 admission presence/status/revision still match the audit;
4. M40 evidence still belongs to the exact M42 handoff.

If any of those changed, execution fails closed and a fresh audit is required.

Execution routes through the already-governed lower layers:

```text
resume
  -> M41/M42 resume()
  -> M40/M36 recovery as required

cancel
  -> M41/M42 release()
  -> M43 cancellation fence
  -> safe release

review
  -> no mutation
```

M44 therefore does not bypass M40, M41, M42 or M43 invariants.

## Example

```ts
const recoveries = new RuntimeFleetHandoffRecoveryCatalog(
  reservationCatalog,
  fairDispatcher,
  new MemoryRuntimeFleetHandoffRecoveryStore(),
);

const audit = await recoveries.audit({
  recoveryId: "recovery-2026-09-27T12:00Z",
  policy,
});

for (const decision of audit.decisions) {
  if (decision.action !== "review") {
    await recoveries.execute(audit.recoveryId, decision.reservationId);
  }
}
```

The loop above is deliberately caller-controlled. Applications may require approvals, maintenance windows or operator review before invoking `execute()`.

## Boundary

M44 is database-neutral and application-agnostic. It does not add tenants, environments, schedulers, background workers or database drivers to `@nublox/metaobject`.
