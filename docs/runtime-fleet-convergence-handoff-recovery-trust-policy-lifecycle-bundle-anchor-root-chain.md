# M62 — External trust-root chain resolution

M62 turns the M59–M61 external trust-root evidence into one deterministic answer to a critical question: **which root snapshot is authoritative now?**

The resolver does not choose a root by recency, identifier, publication time or caller preference. It replays and verifies the entire immutable evidence chain and fails closed unless exactly one active tip can be proven.

## Inputs

M62 consumes the existing evidence contracts:

- M59 immutable external trust-root snapshots and canonical SHA-256 root digests
- M60 append-only governance events (`activated`, `retired`, `revoked`)
- M61 append-only recoverable rotation events (`planned`, `successor-activated`, `predecessor-retired`, `completed`)

M62 adds no mutation path. It is a read/verification boundary.

## Resolution rules

`RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootChainResolver.resolve()`:

1. validates every published M59 snapshot and recomputes its canonical root digest;
2. replays all M60 governance histories and rejects references to unknown snapshots;
3. replays all M61 rotation histories and verifies their frozen predecessor/successor digests;
4. rejects rotation forks, merges and cycles;
5. proves each completed rotation contains the exact M60 successor-activation and predecessor-retirement events created by that rotation;
6. refuses to resolve authority while any M61 rotation remains incomplete;
7. requires exactly one currently active M60 snapshot;
8. requires that active snapshot to be the tip of the completed rotation graph;
9. walks predecessor links back to the lineage origin; and
10. rejects disconnected completed rotation islands.

The result therefore represents one fully verified authority lineage rather than a best-effort selection.

## Output

A successful resolution includes:

- the authoritative snapshot ID;
- the authoritative canonical root digest;
- the complete oldest-to-newest lineage;
- each lineage member's current governance status;
- the M61 rotation that introduced each successor;
- the completed rotation IDs;
- counts of published and governed snapshots; and
- the verification timestamp.

The record format is `nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-external-root-chain-resolution` version 1.

## Fail-closed conditions

Authority is not returned when evidence contains any of the following:

- modified M59 root material;
- unknown snapshot references;
- malformed M60/M61 replay history;
- frozen M61 digest mismatch;
- one predecessor with competing successors;
- one successor with competing predecessors;
- a rotation cycle;
- incomplete rotation work;
- a completed rotation without its exact M60 side-effect evidence;
- zero active roots;
- more than one active root;
- an active root that is not a completed-lineage tip; or
- completed rotation evidence split across disconnected authority lineages.

## Why incomplete rotations block resolution

M61 is deliberately recoverable across process crashes. During recovery there may temporarily be two active roots, or the successor may be active before the predecessor retirement is recorded. M62 does not attempt to infer the intended authority during that window. The M61 rotation must first be resumed to a completed state, after which M62 can prove the resulting authority unambiguously.

## Non-goals

M62 does not:

- rotate roots;
- activate, retire or revoke snapshots;
- rewrite historical M59–M61 evidence;
- manage private keys, certificates, KMS or HSM infrastructure; or
- select between competing authorities using policy or timestamps.

Those boundaries keep trust-root authority derived solely from explicit immutable provenance.
