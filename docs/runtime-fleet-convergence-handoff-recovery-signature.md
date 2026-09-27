# Runtime Fleet Handoff Recovery Evidence Signatures (M50)

M50 adds immutable signature envelopes over the M49 recovery-evidence integrity root.

## Purpose

M49 detects later mutation of the M44-M48 evidence chain. M50 lets an external trust provider sign the exact M49 integrity payload so callers can also verify who/what trust domain attested to that root.

## Trust boundary

The core package never stores private keys and does not implement KMS, HSM, PKI, certificate validation or key rotation.

Callers register a `RuntimeFleetHandoffRecoveryEvidenceSignatureProvider` which supplies:

- `signerId`
- `sign(payload)`
- `verify(payload, material)`

The provider returns opaque signature material containing:

- `algorithm`
- `keyId`
- `signature`

This allows integrations with AWS KMS, Azure Key Vault, Google Cloud KMS, HSMs, WebCrypto, enterprise PKI or another external trust system without coupling the standalone package to any one provider.

## Canonical signed payload

M50 signs a deterministic `nublox-json-canonical-v1` payload containing:

- M49 integrity ID
- M48 attestation ID
- M44 recovery ID
- M49 root digest
- digest algorithm
- canonicalization identifier

A SHA-256 `payloadDigest` is also retained in the immutable signature envelope.

## Safety

Before signing, M50 invokes M49 verification. Invalid or drifted integrity evidence is refused.

Verification independently checks:

1. M49 is still valid;
2. the current M49 identity/root matches the signed envelope;
3. the canonical payload digest matches;
4. the registered external verifier accepts the signature material.

Provider lookup or verification failures fail closed as `signatureValid: false`.

## Persistence

`RuntimeFleetHandoffRecoveryEvidenceSignatureRecord` is create-only and stores no secret material. It records signer/key metadata and the opaque signature returned by the provider.

Reference persistence is provided by `MemoryRuntimeFleetHandoffRecoveryEvidenceSignatureStore`.

## Resulting evidence chain

```text
M44 recovery decision
        ↓
M45 resolution
        ↓
M46/M47 execution evidence
        ↓
M48 chain attestation
        ↓
M49 SHA-256 integrity root
        ↓
M50 external signature envelope
```
