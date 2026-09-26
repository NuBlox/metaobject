# Remediation closure integrity

M27 hardens M25 closure against legacy evidence and narrow concurrency races discovered during post-merge review.

## Exact deployment incarnation

M22/M23 retained optional `deploymentCreatedAt` fields for backwards-compatible historical records. That is sufficient for general historical reading, but it is not strong enough to prove a new remediation closure.

M27 therefore requires `deploymentCreatedAt` on the post-remediation:

- M22 attestation;
- replacement M23 baseline;
- closure M23 assessment.

A remediation case cannot close using legacy revision-only evidence.

This prevents a deleted deployment from being replaced under the same id and revision while old evidence is incorrectly treated as proof of the replacement deployment.

## Durable closing phase

The M25 lifecycle is extended:

```text
planned
  ↓
deploying
  ↓
verifying
  ↓
closing
  ↓
closed
```

`closing` is persisted before the final deployment guard. The exact replacement baseline and closure assessment are therefore already bound to the durable case before the closure boundary is evaluated.

## Compensating invalidation

M27 checks the repair deployment twice around the durable `closed` transition:

```text
verified evidence
      ↓
persist closing
      ↓
check repair deployment
      ↓
persist closed
      ↓
check repair deployment again
```

If the deployment changes across either boundary, the case is moved to `review` and the close operation throws a concurrency error.

A closed case remains immutable for normal writes. The only permitted closed-record mutation is this narrow compensating `closed → review` invalidation, retaining the original repair deployment, attestation, replacement baseline, closure assessment and `closedAt` evidence.

A deployment mutation that occurs only after the second post-close read is subsequent drift rather than a failed closure. M26 posture will surface that later state as `stale`.

## Planned review

`requireReview()` may now consistently move a newly planned case to `review` before any repair deployment exists. This supports operator holds or external governance decisions made before execution starts.

## Adapter guidance

A production adapter with a shared transactional database may implement an even stronger single-transaction closure primitive. The core reference contract remains database-neutral and uses durable staging plus compensating invalidation so separate pluggable stores cannot silently leave a known race as `closed`.
