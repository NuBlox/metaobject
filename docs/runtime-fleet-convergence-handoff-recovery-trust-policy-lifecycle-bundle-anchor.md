# M58 — External Bundle Trust Anchor

M58 closes the in-package lifecycle-trust chain by binding one exact M57 bundle root to an authority that is trusted **outside** `@nublox/metaobject`.

## Why this exists

M57 can prove that a portable bundle is internally reproducible: its M52/M53 history validates, M54 re-verifies, M55 signatures verify, and M56 recomputes to the frozen decision.

That is not sufficient to answer a different question:

> Is this the exact M57 bundle and M56 policy definition that my organisation authorises?

Without an external anchor, someone who could replace the entire M57 bundle—including its frozen M56 policy—and recompute its internal bundle digest would still need a separately trusted reference to be detected.

M58 provides that reference.

## Anchor payload

The canonical `nublox-json-canonical-v1` payload binds:

- bundle ID
- M54 attestation ID
- M56 evaluation ID
- governed recovery-policy ID
- lifecycle revision
- M57 bundle root digest
- M57 digest algorithm
- M57 canonicalization contract

The external anchor record additionally stores:

- anchor ID
- authority ID
- external signature algorithm
- external key ID
- signature material
- payload SHA-256 digest
- anchoring timestamp

## External root-of-trust

M58 deliberately does **not** persist another trust policy for anchor authorities.

At verification time the caller supplies trusted roots out-of-band:

```text
trusted authority: enterprise-root
allowed algorithm: ROOT-SIGN-v1
allowed key: root-key-2026
```

Those roots can come from infrastructure configuration, an HSM/KMS trust store, PKI policy, deployment configuration, a regulated trust register, or another authority outside this package.

This is the explicit recursion stop.

```text
M54 lifecycle integrity
        ↓
M55 lifecycle signatures
        ↓
M56 lifecycle signature trust
        ↓
M57 portable bundle/root
        ↓
M58 external authority signature
        ↓
out-of-band trusted root
```

## Signing safety

Before signing, M58 requires the M57 bundle to verify successfully.

The bundle identity/root is read before signing and read again after the external signer returns. If the bundle changes during that window, M58 fails with a concurrency error and does not persist the anchor.

This prevents a mutation race across a potentially remote KMS/HSM signing operation.

## Verification

M58 independently reports:

- `bundleValid` — current M57 verification result
- `payloadMatches` — anchor still refers to the exact bundle identity/root
- `authorityTrusted` — anchor authority, algorithm and key are allowed by the caller-supplied external trust roots
- `signatureValid` — external provider verifies the signature
- `valid` — all four conditions are true

A cryptographically valid signature from an authority/key that is not trusted by the caller remains cryptographically valid but is **not** an accepted trust anchor.

Likewise, replacement of the bundle with another internally valid root fails `payloadMatches` because the external signature is bound to the original M57 root.

## Provider boundary

M58 reuses the M50 signature-provider registry. The package stores no private keys and embeds no KMS/HSM/PKI SDK.

## Persistence

`RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleBundleAnchorStore` is create-only. The reference memory store returns detached records and supports filtering by:

- bundle ID
- authority ID
- key ID

## Boundary

M58 does not:

- persist the external trust-root configuration
- manage root certificates or keys
- define another lifecycle for root authority policy
- automatically rotate keys
- mutate M57 bundles
- execute recovery/deployment work
- schedule background verification

Root authority configuration is intentionally an external responsibility so the package trust model terminates rather than becoming self-referential.
