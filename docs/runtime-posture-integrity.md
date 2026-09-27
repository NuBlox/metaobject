# Runtime posture integrity

M30 hardens runtime posture against cross-chain evidence mismatches and adapter assumptions discovered during post-merge review.

## One deployment snapshot across the complete evidence chain

A posture snapshot now requires the M22 attestation, M23 baseline and M23 assessment to agree on:

- deployment id;
- deployment revision;
- deployment creation identity (`deploymentCreatedAt`);
- profile id/version.

Creation identity is mandatory for new posture. Historical evidence that only carries a revision remains readable through its original APIs, but cannot be promoted into a new `verified` posture snapshot.

## Closed-case restoration proof

A closed M25 remediation case only produces `restored` posture when all closure links match the supplied evidence:

```text
case.repairDeploymentId      == baseline.deploymentId
case.repairAttestationId     == baseline.attestationId
case.replacementBaselineId   == baseline.baselineId
case.closureAssessmentId     == assessment.assessmentId
```

The closure assessment must additionally be:

```text
outcome = clean
all checks = unchanged
```

An individually valid but directly persisted malformed closed case therefore cannot manufacture a restored posture.

## Open-case source provenance

Open/remediating/review cases must match all source fields:

- `sourceAssessmentId`;
- `sourceBaselineId`;
- `sourceDeploymentId`.

Matching only the assessment id is no longer sufficient.

## Late deployment read

`RuntimePostureCatalog.capture()` performs its deployment read after asynchronous attestation/baseline/assessment/case lookups and immediately before snapshot construction/persistence.

This prevents an asynchronous lookup from leaving capture based on a deployment record read before the runtime evidence changed. Active remediation remains reported as `remediating` or `review`, but the snapshot records the latest observed deployment revision.

## Adapter-independent latest/history

`RuntimePostureSnapshotStore.list()` is not required to return records in chronological order.

M30 therefore sorts/reduces in `RuntimePostureCatalog` itself using:

1. `capturedAt`;
2. `snapshotId` as deterministic tie-breaker.

`latest(runtimeId)` and `history(runtimeId)` are therefore correct for arbitrary compliant storage adapters.

## Validation

Persisted posture snapshots now validate the runtime values of both:

- `state`;
- `driftOutcome`.

This prevents malformed JavaScript/imported records from bypassing the TypeScript unions.
