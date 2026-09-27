# M59 — External Trust Root Snapshots

M59 freezes the exact public trust-root configuration used to evaluate an M58 external bundle anchor.

## Why this exists

M58 deliberately receives trusted authorities out-of-band. That stops recursive in-package trust governance, but historical verification still needs to answer:

> Which external authorities, algorithms and public key identifiers were accepted when this anchor was verified?

M59 provides immutable, canonical snapshots of that public configuration without storing private keys, certificates, secrets or KMS/HSM credentials.

## Snapshot contents

Each snapshot contains:

- snapshot ID
- ordered authority IDs
- optional allowed algorithms for each authority
- optional allowed key IDs for each authority
- canonicalization contract: `nublox-json-canonical-v1`
- digest algorithm: SHA-256
- root digest
- publication timestamp

Input ordering does not affect the digest: authorities, algorithms and key IDs are normalized deterministically before hashing.

## Bound verification

`RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorRootBoundCatalog` verifies one exact M58 anchor using one exact M59 snapshot and persists a create-only binding containing:

- binding ID
- anchor ID
- snapshot ID
- snapshot digest
- M58 `anchorValid`
- M58 `authorityTrusted`
- M58 `signatureValid`
- binding timestamp

The snapshot digest is checked before M58 verification. If snapshot content is later corrupted or replaced without the same digest, binding fails closed before the anchor verifier is called.

## Trust boundary

M59 snapshots only public trust configuration. It does not manage:

- private keys
- certificates
- KMS/HSM credentials
- PKI issuance or revocation
- automatic root rotation
- background re-verification

External key custody and root authority remain out-of-band responsibilities.

## Chain

```text
M57 portable trust bundle
        ↓
M58 external authority anchor
        ↓
M59 immutable external-root snapshot
        ↓
M59 anchor/root verification binding
```

This preserves M58's recursion stop while making historical trust decisions reproducible and auditable.
