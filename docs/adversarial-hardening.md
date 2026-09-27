# Adversarial hardening

M67 is the final hardening pass before the first v1 release candidate. It adds no new product capability; it attempts to make existing portable evidence, lifecycle replay, graph resolution, concurrency and package boundaries fail closed under malformed or tampered inputs.

## Audit scope

The audit reviewed the existing coverage across:

- metadata/module lockfile tampering;
- optimistic concurrency and atomic persistence;
- deployment journal sequence and append-only integrity;
- runtime posture/control evidence identity;
- recovery-chain integrity and signatures;
- trust-policy snapshots and lifecycle integrity;
- portable lifecycle bundles and external anchors;
- M59 external trust-root snapshots;
- M60 root governance replay;
- M61 root rotation replay;
- M62 authoritative root-chain resolution;
- package/clean-consumer verification on the supported Node matrix.

## Defect closed by M67

M60 governance and M61 rotation event records already validated each timestamp individually, revisions and transition ordering, but replay did not reject a later revision whose `occurredAt` moved backwards in time.

M67 closes that gap. Both replay functions now require non-decreasing timestamps in revision order. Equal timestamps remain legal so deterministic/fixed-clock stores continue to work.

A timestamp regression is structural evidence corruption and therefore throws `MetadataError`; it is never normalized, reordered by time, or accepted as current authority evidence.

## Adversarial matrix added

The RC matrix explicitly verifies:

| Boundary | Adversarial case | Required result |
| --- | --- | --- |
| M60 governance | timestamp regression | reject |
| M60 governance | unsupported portable format version | reject |
| M61 rotation | timestamp regression | reject |
| M61 rotation | frozen predecessor/successor identity mutation | reject |
| M61 rotation | missing/reordered stage or revision gap | reject |
| M62 chain resolution | duplicate immutable snapshot records | reject |
| M62 chain resolution | removal of exact M61-created M60 activation evidence | reject |
| M62 chain resolution | consistently rewritten frozen rotation digest | reject |
| M59 canonical digest | equivalent authority/algorithm/key permutations | produce the same digest |

These tests supplement, rather than replace, the existing tamper coverage for module lockfiles, deployment journals, evidence components, policy snapshots, lifecycle events, portable bundles, signatures and trust-root material.

## Fail-closed rules

The RC line follows these rules:

1. Unsupported `formatVersion` values are rejected; they are not guessed or coerced.
2. Revision/event sequences must be contiguous and legal for the lifecycle being replayed.
3. Event time may remain equal across revisions but may not regress.
4. Frozen identities and digests may not change across an event stream.
5. Missing exact provenance is not replaced with equivalent-looking state.
6. Duplicate, disconnected, cyclic, forked or merged authority evidence is rejected.
7. Cryptographic/provider/verifier errors never produce trusted outcomes.
8. Optimistic-concurrency failures do not partially commit atomic batches.
9. Returned in-memory evidence is detached so caller mutation cannot rewrite stored history.
10. Package verification tests the generated installable artifact, not only repository source imports.

## Audit conclusion

After the timestamp-replay fix and the M67 adversarial matrix, no known fail-open defect remains in the reviewed trust, lifecycle, concurrency or persistence boundaries. This is a statement about known findings at the M67 audit point, not a claim that future defects are impossible.

The final M68 RC cut must still run the complete Node 20/22/24 matrix, package-manifest verification and clean-consumer verification from the exact release-candidate commit.
