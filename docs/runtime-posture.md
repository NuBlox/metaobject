# Continuous runtime posture

M26 provides a durable, queryable point-in-time projection over the authoritative M22–M25 evidence chain. It answers a practical operational question without mutating the underlying evidence:

> What is the verified state of this runtime right now?

A posture snapshot is derived evidence. Attestations, drift baselines, assessments, deployments and remediation cases remain authoritative and immutable according to their own contracts.

## States

`RuntimePostureState` has seven states:

- `verified` — the latest supplied M23 assessment is clean and still bound to the current completed deployment snapshot;
- `warning` — the assessment contains unverifiable evidence;
- `drifted` — M23 detected divergence and no remediation case is supplied;
- `remediating` — an M25 case for the supplied source assessment is planned/deploying/verifying;
- `review` — the matching M25 case requires manual review;
- `restored` — a closed M25 case is backed by its replacement baseline and clean closure assessment;
- `stale` — the deployment snapshot changed after the supplied evidence was captured.

## Capture

The caller supplies its own stable `runtimeId`. Core deliberately does not impose tenant, environment, cluster or site semantics.

```ts
const snapshots = new MemoryRuntimePostureSnapshotStore();
const posture = new RuntimePostureCatalog(
  snapshots,
  deploymentStore,
  attestationStore,
  baselineStore,
  assessmentStore,
  remediationCaseStore,
);

const snapshot = await posture.capture({
  snapshotId: "posture-2026-09-27T00:00Z",
  runtimeId: "production-eu-west",
  baselineId: "baseline-42",
  assessmentId: "assessment-42",
});
```

A supplied M25 case may be included:

```ts
await posture.capture({
  snapshotId: "posture-43",
  runtimeId: "production-eu-west",
  baselineId: "baseline-drifted",
  assessmentId: "assessment-drifted",
  remediationCaseId: "case-17",
});
```

Open cases must originate from the supplied assessment. Closed cases must close the exact supplied replacement baseline and closure assessment.

## Evidence-chain validation

Before calculating posture, M26 validates:

```text
M22 attestation
      ↓
M23 baseline
      ↓
M23 assessment
      ↓ optional
M25 remediation case
```

The deployment/profile identity must be consistent across the chain. Failed attestations cannot support posture.

## Staleness

A previously clean assessment is not treated as permanently clean. M26 re-reads the persisted deployment record and compares the deployment revision and creation identity recorded by the assessment.

If that deployment snapshot no longer matches, ordinary `verified`, `warning`, `drifted` or `restored` posture becomes `stale`.

Active remediation remains visible as `remediating` or `review`, because external state may intentionally be changing while repair work is underway.

## Immutable history

`RuntimePostureSnapshotStore` is create-only. The in-memory reference implementation returns detached copies and rejects duplicate snapshot ids.

```ts
const latest = await posture.latest("production-eu-west");
const history = await posture.history("production-eu-west");
```

This produces a time series such as:

```text
verified
   ↓
drifted
   ↓
remediating
   ↓
restored
   ↓
stale
```

without rewriting historical observations.

## Responsibility boundary

M26 does not schedule probes or remediation. An application, service or scheduler decides when to run M23 assessments and capture posture. Core provides deterministic evidence validation, state classification and immutable posture history.
