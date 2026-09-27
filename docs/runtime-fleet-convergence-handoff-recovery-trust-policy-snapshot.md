# M52 — Recovery Evidence Trust Policy Snapshot & Integrity

M52 hardens M51 trust decisions by making the policy definition itself immutable evidence.

## Problem

M51 persisted `policyId` and `policyVersion`, but those two values alone do not prove that the policy definition used historically is still the same definition later associated with that identity.

A policy labelled `dual-control@1` must never be silently redefined after a trust decision has been made.

## Published policy snapshot

`RuntimeFleetHandoffRecoveryEvidenceTrustPolicySnapshotCatalog.publish()` creates one immutable snapshot for an exact `(policyId, version)` pair.

The snapshot stores:

- the complete policy definition;
- canonicalization identifier `nublox-json-canonical-v1`;
- digest algorithm `SHA-256`;
- the canonical policy digest;
- immutable publication time.

The reference memory store rejects any second snapshot for the same `policyId@version`, even when the caller chooses another snapshot ID.

## Canonical digest

The policy digest is calculated from:

```text
{
  format: nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy,
  formatVersion: 1,
  policy: <exact policy definition>
}
```

using the same deterministic canonical JSON and SHA-256 primitives introduced by M49.

## Policy-bound trust evaluation

`RuntimeFleetHandoffRecoveryEvidenceTrustPolicyBoundCatalog` is the recommended high-level entrypoint for new trust decisions.

```text
published M52 policy snapshot
        ↓
exact immutable policy definition
        ↓
M51 signature/quorum evaluation
        ↓
M52 immutable policy binding
```

A binding records:

- binding ID;
- M51 evaluation ID;
- M49 integrity ID;
- M52 policy snapshot ID;
- exact policy ID/version;
- exact policy digest;
- M51 trusted/untrusted decision;
- M51 evaluation timestamp;
- binding timestamp.

## Crash recovery

M51 and M52 use separate persistence contracts. A process can therefore fail after M51 persists its evaluation but before M52 writes the binding.

A retry is safe: M52 reuses the existing M51 evaluation only when its integrity ID, policy ID/version and quorum exactly match the published snapshot. A mismatched historical evaluation fails closed.

## Verification

`verify(bindingId)` reloads both the policy snapshot and M51 evaluation and checks:

1. the embedded policy still produces the recorded SHA-256 digest;
2. the snapshot digest equals the digest frozen into the binding;
3. the M51 evaluation still has the exact bound identity and decision.

The result exposes `policyDigestMatches` and `evaluationMatches` separately for diagnostics.

## Compatibility

M52 does not change the M51 record format. Existing M51 evaluations remain readable. New callers that require policy-definition integrity should use the M52 policy snapshot and policy-bound evaluation APIs.

## Boundary

M52 does not:

- sign policies;
- manage keys or certificates;
- authorize policy publishers;
- replace M50 signature verification;
- replace M51 quorum evaluation;
- execute recovery actions;
- introduce a scheduler.

Those concerns remain outside this standalone package or in their existing governed layers.
