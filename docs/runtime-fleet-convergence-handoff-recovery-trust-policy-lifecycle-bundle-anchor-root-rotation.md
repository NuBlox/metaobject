# M61 — Recoverable external trust-root rotation

M61 adds a durable supersession workflow above the immutable M59 external trust-root snapshots and M60 governance lifecycle.

## Purpose

Trust roots must rotate without destroying historical verification. A new root becoming active is not enough: a trustworthy system must also prove which root it replaced, preserve the exact root material involved, survive interruption between lifecycle mutations, and reject unrelated governance changes that happen to leave snapshots in superficially compatible states.

M61 therefore models rotation as an append-only four-stage provenance chain:

1. `planned`
2. `successor-activated`
3. `predecessor-retired`
4. `completed`

Every event freezes both snapshot IDs and both canonical M59 root digests.

## Invariants

- predecessor and successor snapshot IDs must differ;
- both M59 snapshots must exist and pass canonical digest verification before a rotation can be planned or resumed;
- the predecessor must be M60 `active` when planning begins;
- the successor must not already have M60 governance state when planning begins;
- one predecessor can record only one successor;
- one snapshot can be introduced as the successor of only one rotation;
- rotation event revisions are contiguous and the event-type sequence is fixed;
- snapshot identities and digests are immutable across the rotation event stream;
- completion requires the successor to be active and the predecessor to be retired through governance events owned by the rotation;
- M60 revocation remains terminal and cannot be bypassed by M61;
- completed rotations are idempotent to resume.

## Crash recovery

M61 deliberately coordinates across separate append-only M59/M60/M61 stores rather than pretending they form a single transaction.

The workflow uses deterministic M60 event IDs:

- `<rotationId>:m60:activate-successor`
- `<rotationId>:m60:retire-predecessor`

If a process fails after an M60 mutation commits but before the corresponding M61 stage event is written, `resume()` inspects M60 history. It accepts the already-committed mutation only when the deterministic event ID and event type prove that the mutation belongs to the same rotation. An independently activated or retired snapshot fails closed.

## API

`RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationCatalog` provides:

- `plan(request)` — validates and freezes a predecessor/successor pair;
- `rotate(request)` — plans when necessary and drives the workflow to completion;
- `resume(rotationId)` — safely resumes an interrupted rotation;
- `getState(rotationId)` — deterministically replays current rotation state;
- `history(rotationId?)` — returns detached append-only provenance events.

`MemoryRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationStore` is the reference in-memory store implementation.

## Relationship to earlier milestones

M59 preserves the exact external root set used for trust. M60 governs whether a snapshot may authorize new work. M61 links successive governed snapshots into a recoverable, immutable supersession chain.

Historical anchor/root bindings remain unchanged. Rotation changes which root snapshot is authoritative for new work; it does not rewrite the trust basis of existing evidence.
