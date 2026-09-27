# Runtime Fleet Handoff Recovery Evidence Trust Policy (M51)

M51 evaluates one exact M49 integrity record and its M50 signature envelopes against a versioned multi-signer trust policy.

## Purpose

M50 proves that a configured external signer accepted one exact M49 integrity root. M51 answers the higher-level question: **is the available signed evidence sufficient to satisfy the caller's trust policy?**

## Policy model

A trust policy defines:

- `policyId`
- `version`
- `minimumValidSignatures`
- allowed signer IDs
- optional required signers
- optional allowed signature algorithms per signer
- optional allowed key IDs per signer

Each signer contributes at most one accepted signature to quorum, even when multiple valid envelopes from that signer exist.

## Evaluation

For one integrity ID, M51:

1. loads all M50 envelopes for that integrity root;
2. rejects signers not listed by policy;
3. applies algorithm/key restrictions;
4. invokes M50 verification for each remaining envelope;
5. fails closed on verification errors;
6. accepts at most one valid signature per signer;
7. checks quorum;
8. checks all required signers;
9. persists an immutable `trusted` or `untrusted` evaluation.

## Evidence

Each signature decision records:

- signature ID
- signer ID
- algorithm
- key ID
- verification validity
- whether it counted toward quorum
- reason for acceptance or rejection

The evaluation also records the valid signer set and any missing required signers.

## Boundary

M51 does not manage keys, certificates, identities or authorization. It does not create signatures, execute recovery work, schedule evaluation, or alter M49/M50 evidence. Authentication and mapping of real-world principals to signer IDs remain application/integration concerns.

## Resulting chain

```text
M48 chain attestation
        ↓
M49 deterministic integrity root
        ↓
M50 signed evidence envelopes
        ↓
M51 versioned signer/quorum policy
        ↓
trusted / untrusted decision
```
