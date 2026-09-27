# Runtime Fleet Handoff Recovery Evidence Integrity (M49)

M49 adds deterministic tamper-evidence for the governed recovery chain established by M44-M48.

## Purpose

M48 proves that one recovery chain was internally consistent at attestation time. M49 freezes cryptographic digests of the exact evidence that supported that attestation so later changes can be detected.

M49 is read-only over the recovery chain. It does not retry, resume, cancel, schedule, mutate, sign, or authorize recovery actions.

## Evidence covered

Each integrity record stores an ordered SHA-256 digest for:

1. M44 recovery audit
2. M45 recovery resolution
3. M46/M47 execution receipt
4. terminal M42 reservation
5. terminal M40 admission, when present
6. M48 recovery-chain attestation

The ordered component digests are themselves canonicalized and hashed into one root digest.

## Canonicalization

`nublox-json-canonical-v1` recursively:

- preserves array order;
- sorts object keys lexicographically;
- omits object properties whose value is `undefined`;
- rejects non-finite numbers and unsupported JavaScript value types.

The canonical string is UTF-8 encoded and hashed with SHA-256.

## Integrity lifecycle

Integrity records are create-only. `verify(integrityId)` reloads the live recovery evidence, recomputes every component digest and the root digest, and reports:

- `valid`
- expected root digest
- actual root digest
- exact mismatched component names
- verification timestamp

A changed source record therefore produces explicit evidence of which chain component no longer matches the integrity snapshot.

## Optional M40 admission

A valid M48 chain can state that no M40 admission existed. M49 represents that state explicitly as:

```json
{ "component": "admission", "present": false }
```

The absence itself participates in the root digest. If an admission later appears, verification fails for the `admission` component.

## Security boundary

M49 provides **tamper evidence**, not an external trust anchor. SHA-256 proves that later data differs from the captured digest; it does not prove who created or approved the evidence.

Digital signatures, HSM/KMS integration, certificate trust, timestamp authorities and external transparency logs belong in a separate integration/trust layer.

## API

Primary types:

- `RuntimeFleetHandoffRecoveryEvidenceIntegrityCatalog`
- `RuntimeFleetHandoffRecoveryEvidenceIntegrityRecord`
- `RuntimeFleetHandoffRecoveryEvidenceIntegrityStore`
- `MemoryRuntimeFleetHandoffRecoveryEvidenceIntegrityStore`
- `RuntimeFleetHandoffRecoveryEvidenceVerification`
- `canonicalizeJson()`
- `sha256Hex()`

## Resulting recovery chain

```text
M44 recovery decision
        ↓
M45 explicit resolution
        ↓
M46 durable execution receipt
        ↓
M47 full handoff identity
        ↓
M48 chain attestation
        ↓
M49 canonical component digests
        ↓
M49 root SHA-256 integrity digest
```
