# M54 — Trust Policy Lifecycle Integrity

M54 makes the complete M53 trust-policy lifecycle tamper-evident.

## Purpose

M52 freezes each policy version and M53 governs which frozen version is authoritative for new trust decisions. M54 proves the exact governed sequence by which the current lifecycle state was reached.

It does this by validating the M53 event stream semantically, resolving every referenced M52 snapshot, and creating a canonical SHA-256 root over the lifecycle evidence.

## Validated lifecycle invariants

Before an integrity attestation can be created, M54 requires:

- event revisions are contiguous from `1..current.revision`;
- the first event is an activation;
- the first activation has no previous snapshot state;
- every later activation references the exact prior snapshot/version and strictly advances policy version;
- retirement can only follow an active state;
- retirement keeps the same snapshot/version and references that exact prior state;
- event timestamps are monotonic;
- every referenced M52 snapshot exists;
- each snapshot matches the event policy identity/version;
- each M52 `policyDigest` still matches the canonical policy definition;
- M53 current state is exactly derivable from the final event.

## Integrity record

`RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityRecord` stores:

- `attestationId`;
- policy identity;
- lifecycle revision/status;
- current snapshot/version;
- ordered event SHA-256 digests;
- referenced M52 snapshot policy digests;
- current-state digest;
- root digest;
- canonicalization and algorithm metadata;
- creation timestamp.

The canonicalization format is `nublox-json-canonical-v1` and the digest algorithm is SHA-256.

## Verification

`verify()` reloads the live M52/M53 evidence, revalidates the lifecycle chain, recomputes all digests, and reports:

- `chainValid`;
- `eventsMatch`;
- `snapshotsMatch`;
- `currentStateMatches`;
- `rootDigestMatches`;
- overall `valid`.

If lifecycle evidence is structurally invalid, verification fails closed with `chainValid: false`.

## Persistence

M54 defines a create-only persistence contract:

- `RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityStore`
- `MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleIntegrityStore`

Reference-store reads are detached and historical attestations are immutable.

## Resulting trust chain

```text
M49 recovery evidence integrity
        ↓
M50 external signature
        ↓
M51 signer/quorum trust policy
        ↓
M52 immutable policy snapshot
        ↓
M53 active/retired lifecycle
        ↓
M54 lifecycle integrity attestation
```

M54 does not replace M52 policy integrity or M51/M50 recovery-evidence trust. It proves the lifecycle history governing which M52 snapshot became authoritative.