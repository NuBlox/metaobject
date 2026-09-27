# M53 — Recovery Evidence Trust Policy Activation & Supersession

M53 adds a governed current-policy layer on top of M52's immutable trust policy snapshots.

## Why this exists

M52 guarantees that `policyId@version` cannot be silently redefined. It does not by itself answer which immutable version is authoritative for new trust evaluations.

M53 introduces that lifecycle decision without changing historical M52 bindings.

## Lifecycle state

Each policy ID has at most one current lifecycle record:

```text
active
  ↓
retired
  ↓
active again only through a newer snapshot version
```

The state carries:

- policy ID;
- optimistic revision;
- active/retired status;
- exact M52 snapshot ID;
- exact policy version;
- activation time;
- optional retirement time;
- update time.

## Forward-only activation

Activation requires an exact M52 snapshot and an expected lifecycle revision.

A new activation must use a policy version strictly greater than the last lifecycle version. This remains true after retirement, so a retired policy cannot simply reactivate the same historical version.

## Atomic lifecycle event

Every activation or retirement is committed atomically with an immutable lifecycle event.

The event records:

- event ID;
- policy ID;
- lifecycle revision;
- action (`activate` or `retire`);
- exact snapshot ID/version;
- previous snapshot identity when present;
- actor ID;
- optional reason;
- occurrence time.

The reference memory store will not update the current state unless the matching event can also be appended.

## Optimistic concurrency

Callers supply `expectedRevision`.

If the current lifecycle revision differs, the operation fails before any state or event is persisted. This prevents two administrators or control planes from independently advancing the same trust policy.

## Current-policy evaluation

`RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleCatalog.evaluateCurrent()` resolves the currently active M52 snapshot and delegates to the policy-bound M52 trust evaluator.

```text
policyId
  ↓
M53 active lifecycle record
  ↓
exact M52 snapshot
  ↓
M52 policy-bound evaluation
  ↓
M51 signature/quorum decision
```

A retired policy cannot authorize a new evaluation.

## Historical stability

M53 does not rewrite old M52 bindings. A trust decision made under version 1 continues to reference version 1 even after version 2 becomes active or version 1 is retired.

## Boundary

M53 records governance provenance but does not:

- authenticate or authorize `actorId`;
- sign policy lifecycle events;
- manage identities, keys or certificates;
- execute recovery work;
- introduce background scheduling;
- alter historical M51/M52 evidence.

Those responsibilities remain outside this standalone package or in their existing governed layers.
