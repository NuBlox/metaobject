# M37 — Runtime Fleet Convergence Queue Policy & Backpressure

M37 adds a deterministic advisory policy layer between M34 durable convergence work and M36 dispatch.

It answers one question:

> Which pending convergence work is eligible to be dispatched now, and why is everything else blocked?

M37 never claims work and never invokes M35 executors. A caller can pass `eligibleWorkIds` from an M37 evaluation into an explicit M36 dispatch.

## Policy model

`RuntimeFleetConvergenceQueuePolicyDefinition` is serializable and versioned. It can define:

- action priorities (higher first),
- per-action concurrency ceilings,
- runtime exclusivity,
- default/per-action attempt ceilings,
- default/per-action cooldown periods,
- same-runtime action dependencies,
- ordered named eligibility rules.

Unspecified priorities default to `0`. Runtime exclusivity defaults to `true`.

## Deterministic allocation

Pending work is ordered by:

1. descending priority,
2. `createdAt`,
3. `workId`.

The planner counts currently `in-progress` M34 work first. It then reserves capacity for eligible pending work as it walks the ordered queue. This means one evaluation produces a safe bounded set that respects concurrency and runtime exclusivity even before M36 starts dispatching it.

## Backpressure gates

A work item may be blocked for one or more reasons:

- `action-concurrency` — the action's active/reserved ceiling is saturated;
- `runtime-exclusive` — another active/reserved item owns the runtime;
- `cooldown` — not enough time has passed since the latest terminal M35 attempt;
- `attempts-exhausted` — the configured attempt ceiling has been reached;
- `dependency` — a prerequisite action for the same runtime is still unfinished;
- `eligibility-rule` — a named rule blocked the item or failed.

Custom eligibility rule exceptions fail closed and become explicit policy evidence.

## Dependencies

Dependencies are same-runtime ordering constraints. For example:

```ts
{
  dependencies: {
    "plan-remediation": ["reassess"]
  }
}
```

means a `plan-remediation` item is blocked while any `reassess` item for that runtime is still pending, in progress, or failed. If no prerequisite work exists, M37 does not invent one.

## Retry/cooldown policy

M37 reads M35 execution history without modifying it. A retried M34 item can therefore be held back by:

- `maxAttemptsByAction` / `defaultMaxAttempts`, and
- `cooldownMsByAction` / `defaultCooldownMs`.

This is advisory backpressure. M34/M35 remain the authority for actual work and attempt state.

## Immutable evaluation evidence

Every evaluation can be stored as a create-only `RuntimeFleetConvergenceQueueEvaluation` containing:

- policy ID/version,
- exact work revision,
- priority,
- eligible/blocked status,
- structured block reasons/details,
- ordered `eligibleWorkIds`,
- evaluation timestamp.

`MemoryRuntimeFleetConvergenceQueueEvaluationStore` is the reference store.

## Typical flow

```text
M33 reconciliation
      ↓
M34 durable work
      ↓
M37 policy evaluation
      ↓
eligibleWorkIds
      ↓
M36 explicit bounded dispatch
      ↓
M35 executor framework
```

## Boundaries

M37 deliberately does **not**:

- run in the background,
- claim M34 work,
- invoke M35 executors,
- retry failed work,
- mutate M31 desired state,
- create M16/M24/M29 plans,
- change M36 dispatch history.

Scheduling remains an application concern. M37 provides deterministic, auditable queue policy and backpressure primitives for that scheduler to use.
