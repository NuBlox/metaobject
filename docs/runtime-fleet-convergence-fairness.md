# M39 — Runtime Fleet Convergence Fairness

M39 is a deterministic fairness overlay for the M37 convergence queue policy.

It never changes M37 safety eligibility. Blocked work remains blocked. M39 only reorders the exact set of work that M37 already marked eligible.

## Goals

- prevent long-waiting work from being permanently suppressed by higher static priorities
- account for queue age without discarding the M37 base priority
- identify and promote starved work
- reduce repeated service to the same runtime or action using recent M36 dispatch history
- prevent long consecutive runs of one runtime or action inside one ordering
- record immutable evidence explaining every final rank

## Inputs

A fairness evaluation references one immutable M37 queue evaluation and a versioned `RuntimeFleetConvergenceFairnessPolicyDefinition`.

The source M34 work item must still:

- exist
- be `pending`
- match the exact revision recorded by M37
- retain the same runtime and action identity

If any source item has changed, fairness evaluation fails rather than ranking stale work.

## Ranking model

For every eligible item M39 records:

- M37 base priority
- queue age
- age boost
- recent selections for the runtime
- recent selections for the action
- runtime-history penalty
- action-history penalty
- effective priority
- starvation state
- final rank

The effective priority is:

```text
basePriority
+ ageBoost
- runtimePenalty
- actionPenalty
```

Starved items sort ahead of non-starved items. Remaining ties are deterministic.

## Age boosting

Age boosting is enabled by `ageBoostStepMs`.

Optional controls:

- `ageBoostAfterMs`
- `ageBoostPerStep`
- `maxAgeBoost`

No age boost is applied when `ageBoostStepMs` is omitted.

## Starvation protection

`starvationThresholdMs` marks work as starved once its queue age reaches the threshold.

Starved work is promoted ahead of non-starved work. This provides a deterministic escape from indefinite suppression by static priority.

## Historical service fairness

M39 can examine the most recent M36 dispatches using `historyDispatches`.

Two optional penalties are available:

- `runtimeHistoryPenalty`
- `actionHistoryPenalty`

Every recently dispatched item increments the corresponding recent-service count, regardless of whether that dispatch item later completed, blocked, or failed. This prevents repeatedly attempting the same runtime or action from dominating the fleet queue.

## Consecutive selection protection

`maxConsecutivePerRuntime` and `maxConsecutivePerAction` are soft ordering caps.

M39 scans the ranked candidates and selects the highest-ranked item that does not violate the current consecutive cap. If every remaining item would violate the cap, the highest-ranked remaining candidate is selected so the queue cannot deadlock.

## Evidence

`RuntimeFleetConvergenceFairnessEvaluation` is create-only and records:

- source M37 evaluation and policy version
- M39 fairness policy and version
- exact recent M36 dispatch IDs used for service history
- ranked fairness decisions
- ordered eligible work IDs
- starved work IDs
- evaluation timestamp

The reference `MemoryRuntimeFleetConvergenceFairnessStore` returns detached copies and rejects duplicate evaluation IDs.

## Boundary with M38

M39 does not dispatch work. M38 remains the stale-safe admission gate immediately before M36.

The intended chain is:

```text
M34 work
  ↓
M37 safety / backpressure evaluation
  ↓
M39 fairness ordering
  ↓
policy-bound admission
  ↓
M36 dispatch
  ↓
M35 execution
```

A later admission layer may bind an exact M39 fairness result directly to dispatch. Until then, M39 is an explicit deterministic ordering artifact that callers can use when selecting eligible M37 work.