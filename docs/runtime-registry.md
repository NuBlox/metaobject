# M31 — Runtime registry and fleet view

`@nublox/metaobject` can now keep a persistent, database-neutral registry of independent runtime targets without introducing tenant, environment, cloud, or application-specific concepts into the core package.

## Runtime identity

`runtimeId` is caller-owned and stable. A registered runtime stores:

- desired profile id/version;
- lifecycle status (`active` or `retired`);
- latest trusted observed posture, when available;
- last attempted M29 control cycle, including failed attempts;
- optimistic revision and timestamps.

The registry is a projection. M26 posture snapshots and M29 control-cycle records remain the authoritative immutable evidence.

## Desired vs observed state

Desired state is intentionally separate from observed state.

```text
Runtime target
├── desired profile
└── latest trusted observation
    ├── observed profile
    ├── deployment
    ├── baseline
    ├── assessment
    ├── posture snapshot/state
    └── optional completed control-cycle response
```

This allows a runtime to be intentionally moving from one profile version to another without pretending that the desired profile is already deployed.

## Failed control cycles

A failed M29 cycle updates `lastControlCycle` but does **not** overwrite the latest trusted observation. This preserves the last known-good posture while still exposing the most recent failed monitoring/control attempt.

A completed cycle advances observation only after the registry verifies that its runtime, baseline, assessment, snapshot and posture-state identities match the referenced M26 posture snapshot.

## Optimistic concurrency

Every mutation requires the current runtime-target revision. The reference `MemoryRuntimeTargetStore` increments revision on every successful save and rejects stale writers.

Persistent adapters should provide equivalent compare-and-swap semantics transactionally.

## Retirement

Retirement is non-destructive. Retired targets remain queryable for history/fleet reporting but cannot accept desired-profile or observation mutations through `RuntimeTargetCatalog`.

## Fleet summary

`RuntimeTargetCatalog.summary()` produces a storage-independent summary with:

- total runtimes;
- active/retired counts;
- posture counts across all M26 states;
- an `unobserved` count for registered runtimes without trusted posture yet.

## Package boundary

M31 does not:

- deploy anything;
- run remediation;
- infer tenant/environment semantics;
- replace M22–M30 evidence stores;
- poll or schedule control cycles.

Applications and adapters decide what a `runtimeId` represents and when observations/control cycles are executed.
