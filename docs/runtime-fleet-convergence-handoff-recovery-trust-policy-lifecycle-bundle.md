# M57 — Portable Lifecycle Trust Bundle

M57 packages the complete historical M52–M56 lifecycle-governance evidence required to reproduce one trust decision away from the live stores.

## Purpose

M54 makes an M52/M53 lifecycle tamper-evident. M55 adds external cryptographic signatures. M56 evaluates those signatures under a dedicated multi-signer trust policy.

Those records are individually durable, but an auditor or disconnected verifier otherwise has to retrieve several stores in exactly the right historical state. M57 freezes the necessary evidence into one deterministic, create-only bundle.

The bundle is **self-describing but not self-trusting**. It contains the evidence and deterministic hashes, while external public-verification providers remain the cryptographic trust anchor. Private keys are never included.

## Included evidence

A bundle contains:

- reconstructed historical M53 lifecycle state at the attested revision
- exact M53 lifecycle event slice through that revision
- exact M52 policy snapshots referenced by those events
- M54 lifecycle integrity attestation
- exact M55 signature envelopes referenced by the M56 evaluation
- exact M56 lifecycle-signature trust policy definition
- exact M56 trust evaluation
- SHA-256 digest for each evidence component
- deterministic bundle root digest

## Historical reconstruction

A key M57 capability is historical verification after the live lifecycle advances.

Example:

```text
M53 revision 1
   ↓
M54 attestation A
   ↓
M55 signatures
   ↓
M56 trusted decision

later...

M53 revision 2
```

At revision 2, live M54 verification of attestation A is no longer current. M57 selects the M53 events through the revision recorded in A, reconstructs the exact historical lifecycle state, resolves the historical M52 snapshots, and verifies A against that frozen evidence.

This lets historical trust evidence remain reproducible without pretending it is the current live policy state.

## Deterministic integrity

M57 uses `nublox-json-canonical-v1` and SHA-256.

Component digests cover:

- `lifecycleState`
- `lifecycleEvents`
- `policySnapshots`
- `lifecycleIntegrity`
- `lifecycleSignatures`
- `trustPolicy`
- `trustEvaluation`

The bundle root binds those digests with:

- bundle ID
- M54 attestation ID
- M56 evaluation ID
- governed policy ID
- attested lifecycle revision
- digest algorithm/canonicalization contract

Any structurally valid mutation of the policy, events, snapshots, signatures or trust decision therefore changes the corresponding component digest and bundle root.

## Offline verification

`verifyRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundle()` rebuilds the verification chain from the bundle itself:

1. recompute all component digests and the M57 root;
2. reconstruct an in-memory M53 lifecycle source from the frozen state/events;
3. load the exact M52 snapshots;
4. re-run M54 lifecycle integrity verification;
5. load the frozen M55 signatures;
6. verify them using caller-supplied M50-compatible public verification providers;
7. re-run M56 using the frozen trust policy;
8. compare the newly derived M56 evaluation with the bundled evaluation.

The verification result reports:

- `componentDigestsMatch`
- `rootDigestMatches`
- `lifecycleIntegrityValid`
- `trustEvaluationMatches`
- original `trustDecision`
- aggregate `valid`

A bundle can be internally valid while its historical M56 decision is `untrusted`. Bundle validity means the evidence faithfully reproduces the recorded decision; it does not rewrite an `untrusted` decision as trusted.

## Persistence

`RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleStore` is create-only. The reference in-memory implementation returns detached records and supports filtering by:

- attestation ID
- governed policy ID
- M56 trust decision

## Boundary and recursion stop

M57 intentionally packages the M56 trust policy definition directly rather than creating another internal policy-lifecycle hierarchy around it. The bundle digest plus external M55/M50 verification boundary is the practical recursive stop.

If an organisation requires governance of the M56 policy itself, that policy authority should be anchored in an external root-of-trust or configuration authority rather than extending an unbounded self-referential policy chain inside `@nublox/metaobject`.

M57 does not:

- contain private keys
- manage certificates or KMS/HSM configuration
- change live M52/M53 state
- execute recovery or deployment work
- schedule background verification
- claim an old attestation is current after the live lifecycle advances
