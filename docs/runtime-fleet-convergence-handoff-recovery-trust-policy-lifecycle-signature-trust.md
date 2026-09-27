# M56 — Lifecycle Signature Trust Policy

M56 evaluates M55 lifecycle-signature envelopes under a dedicated trust policy and persists an immutable `trusted` or `untrusted` decision.

## Purpose

M55 proves that one external signer authenticated one exact M54 lifecycle integrity root. M56 answers the higher-level governance question: **which combination of signers, keys and algorithms is sufficient to trust that lifecycle attestation?**

This policy is deliberately separate from the M51 policy used to trust recovery evidence itself. The subject being trusted here is the governance lifecycle evidence produced by M54/M55.

## Policy model

A lifecycle-signature trust policy defines:

- policy ID
- policy version
- minimum number of distinct valid signers
- allowed signer identities
- optional required signers
- optional allowed algorithms per signer
- optional allowed key IDs per signer

Example:

```text
Policy: lifecycle-governance-trust@1
Minimum valid signatures: 2

security
  required: yes
  algorithms: TEST-SIGN-v1
  keys: security-key

operations
  required: no
  algorithms: TEST-SIGN-v1
  keys: operations-key

audit
  required: no
  algorithms: TEST-SIGN-v1
  keys: audit-key
```

`security + operations` is trusted. `operations + audit` is untrusted because the required `security` signer is missing. Two valid signatures from `security` still count as one signer.

## Evaluation flow

```text
M54 lifecycle integrity
        ↓
M55 external signatures
        ↓
M56 policy constraints
        │
        ├─ allowed signer?
        ├─ allowed algorithm?
        ├─ allowed key?
        ├─ M55 verification valid?
        ├─ signer already counted?
        ├─ required signers present?
        └─ quorum reached?
        ↓
trusted / untrusted
```

Every discovered signature receives a durable decision describing whether it was valid, whether it contributed to quorum and why it was accepted or rejected.

## Fail-closed behavior

M56 treats the following as rejected evidence:

- signer not present in policy
- disallowed signature algorithm
- disallowed key ID
- invalid M55 verification
- thrown verification/provider errors
- additional valid signatures from a signer that already contributed once

A signer identity can contribute at most one signature toward quorum.

## Persistence

`RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureTrustEvaluationStore` is create-only. The reference in-memory implementation returns detached records and supports filtering by attestation ID, policy ID and trust decision.

The persisted evaluation retains:

- exact M54 attestation ID
- policy ID/version
- minimum quorum
- accepted signer IDs
- missing required signer IDs
- every signature decision
- final `trusted`/`untrusted` decision
- evaluation timestamp

## Boundary

M56 does not:

- sign evidence
- manage keys or certificates
- mutate M52–M55 evidence
- activate or retire lifecycle-signature trust policies
- automatically remediate an untrusted decision
- introduce background scheduling

Those concerns remain external or belong to later governance layers.
