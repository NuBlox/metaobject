# M38 — Policy-Bound Fleet Dispatch

M38 binds an exact M37 queue-policy evaluation to one explicit M36 fleet dispatch.

It closes the gap between **eligibility was true when evaluated** and **work is still the same when dispatched**.

## Admission flow

```text
M37 queue evaluation
      ↓
eligibleWorkIds + exact work revisions
      ↓
M38 revalidation
      ↓
durable admission record
      ↓
M36 explicit dispatch
      ↓
terminal admission linked to M36 outcome
```

Before admission, every selected item must still:

- exist,
- be `pending`,
- match the exact M37 work revision,
- match the evaluated runtime/action identity.

Any stale item rejects the whole admission **before M36 is called**.

## Durable admission

`RuntimeFleetPolicyDispatchRecord` stores:

- M37 evaluation ID,
- policy ID/version,
- M36 dispatch ID,
- worker identity,
- exact selected work IDs/runtime/action/revisions,
- admission timestamp,
- terminal M36 outcome or failure.

The work selection and policy provenance are immutable.

## Crash recovery

The admission is persisted before M36 is invoked.

If a process stops:

- before M36 creates its dispatch record, `resume()` invokes M36 with the exact admitted work set and dispatch ID;
- after M36 created its record but before M38 finalized, `resume()` reads that existing dispatch and finalizes the admission without invoking M36 again.

This makes the M37→M36 handoff durable without weakening M34/M35 stale-state and idempotency guarantees.

## Bounds

`maxItems` defaults to 100 and preserves M37's ordered `eligibleWorkIds`. M38 does not reprioritize the policy result.

## Boundaries

M38 does not:

- evaluate queue policy,
- claim M34 work itself,
- execute M35 directly,
- schedule itself,
- mutate M31 desired state,
- retry/recover individual M35 work.

It is an admission/provenance layer between M37 policy evidence and M36 dispatch.
