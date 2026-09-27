# M55 — Signed Trust Policy Lifecycle Attestations

M55 adds an external cryptographic trust anchor to the tamper-evident lifecycle root created by M54.

## Purpose

M54 proves that the M52/M53 policy lifecycle is internally consistent and produces one deterministic SHA-256 root over the complete governed lifecycle evidence. M55 allows an external signer to sign that exact root and its immutable lifecycle identity.

The core package does not store private keys and does not implement key management. Signing remains behind the same provider abstraction introduced by M50, allowing callers to integrate KMS, HSM, PKI, WebCrypto, cloud key vaults or another trust service.

## Signed payload

The canonical `nublox-json-canonical-v1` payload binds:

- M54 attestation ID
- policy ID
- lifecycle revision
- lifecycle status
- active/retired snapshot ID
- policy version
- M54 root digest
- M54 current-state digest
- M54 digest algorithm
- M54 canonicalization contract

The resulting envelope also records:

- signature ID
- signer ID
- signature algorithm
- key ID
- external signature material
- payload SHA-256 digest
- signing timestamp

## Trust boundary

```text
M52 immutable snapshots
        ↓
M53 governed lifecycle
        ↓
M54 lifecycle integrity root
        ↓
canonical M55 signing payload
        ↓
external M50-compatible signer
        ↓
immutable M55 signature envelope
```

The M50 provider registry is deliberately reused. M55 therefore introduces no second KMS/HSM abstraction and no private-key persistence.

## Signing rules

A lifecycle root can be signed only when the referenced M54 attestation currently verifies successfully. If M54 reports an invalid lifecycle chain, altered event/snapshot evidence, a changed current state or a root mismatch, M55 refuses to sign it.

Signature IDs are create-only.

## Verification

M55 verification independently reports:

- `lifecycleIntegrityValid` — whether M54 still verifies against the current governed lifecycle
- `payloadMatches` — whether the persisted signature envelope still matches the exact M54 record and canonical payload
- `signatureValid` — whether the external provider validates the cryptographic signature
- `valid` — true only when all three are true

Provider lookup/verification errors and M54 verifier errors fail closed.

A legitimate later M53 lifecycle transition can make an older M54 attestation no longer current. In that case the M55 cryptographic signature can still remain valid for the historical payload while `lifecycleIntegrityValid` and therefore aggregate `valid` are false. This preserves the distinction between cryptographic authenticity and current lifecycle authority.

## Persistence

`RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleSignatureStore` is create-only. The reference in-memory store returns detached records and supports history filtering by attestation, policy, signer and key.

## Boundary

M55 does not:

- manage keys or certificates
- assign signer authorization
- define signature quorum policy
- alter M52/M53/M54 evidence
- execute recovery or deployment work
- schedule background verification

Those concerns remain external or belong to later governance layers.
