# Runtime fleet reconciliation

M33 adds a read-only convergence layer above the M31 runtime registry. It compares each runtime target's desired profile with its latest trusted observation and classifies the next governed action without changing the runtime or registry record.

## Decision order

Reconciliation deliberately evaluates profile identity/version before posture:

1. retired targets are excluded from convergence;
2. targets without trusted observation require observation establishment;
3. different observed profile ids require review;
4. an older observed version recommends a forward profile-upgrade plan;
5. a newer observed version requires review rather than inferring a downgrade;
6. only an exact desired/observed profile match is evaluated by posture.

Exact-profile posture maps as follows:

| Posture | Compliance | Recommended action |
| --- | --- | --- |
| `verified` | `compliant` | `none` |
| `restored` | `compliant` | `none` |
| `warning` | `warning` | `reassess` |
| `drifted` | `drifted` | `plan-remediation` |
| `remediating` | `remediating` | `wait-remediation` |
| `review` | `review` | `review` |
| `stale` | `stale` | `reassess` |

## Immutable fleet evidence

Each reconciliation produces a create-only `RuntimeFleetReconciliationRun` containing:

- the exact M31 target revision observed for every runtime;
- desired and observed profile identity/version;
- trusted posture where available;
- compliance classification;
- recommended next action;
- deterministic aggregate counts and overall outcome.

The in-memory reference store returns detached records and rejects duplicate run ids.

## Fleet outcomes

A run is classified as:

- `compliant` when no active runtime requires action or review;
- `action-required` when one or more runtimes need a governed action but none require manual review;
- `review-required` when any runtime requires explicit review.

Retired runtimes remain visible in evidence but do not create convergence work.

## Boundary

M33 never:

- updates desired profiles;
- creates upgrade plans;
- starts M29 control cycles;
- creates M24 remediation plans;
- executes deployments;
- infers a downgrade or cross-profile switch.

Callers use the recommended action to enter the existing governed M16/M24/M29 execution paths explicitly.
