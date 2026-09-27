# M60 — External trust-root snapshot governance

M59 made external trust-root configuration immutable and digest-bound. M60 adds governance over those immutable snapshots without mutating the snapshots themselves.

## Purpose

External trust roots need operational lifecycle semantics. A root set may be valid for new anchor verification today, retired after a planned rollover, or revoked after compromise. Historical M59 bindings must remain reproducible even after current authority changes.

M60 therefore separates **immutable trust material** from **append-only governance state**.

## Governance states

A published M59 snapshot can move through the following states:

```text
unmanaged -> active -> retired -> revoked
                    \-> revoked
```

Rules:

- activation is allowed once;
- retirement is allowed only from `active`;
- revocation is allowed from `active` or `retired`;
- `revoked` is terminal;
- every transition increments a monotonic governance revision;
- callers must supply the expected revision for retirement and revocation.

## Append-only event model

M60 stores immutable governance events rather than mutating a current-state record.

Each event binds:

- event ID;
- snapshot ID;
- exact revision;
- transition type;
- optional reason;
- event timestamp.

Current state is reconstructed by deterministic replay. Replay rejects missing revisions, duplicate activation, illegal transitions, cross-snapshot events and any event after revocation.

## Snapshot integrity boundary

A governance transition never makes an invalid M59 snapshot authoritative.

Before activation or subsequent transition, M60:

1. loads the exact M59 snapshot;
2. validates its record format;
3. recomputes the canonical external-root digest;
4. fails closed if the digest differs from the stored digest.

The M59 snapshot remains immutable throughout its governance lifecycle.

## New binding authority

`RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleGovernedBundleAnchorRootCatalog` is the M60 façade for creating new M59 anchor/root bindings.

Before delegating to the existing M59 binding implementation it requires the selected snapshot to be:

- structurally valid;
- digest-valid;
- governed;
- currently `active`.

A retired or revoked snapshot cannot authorize a new binding.

## Historical evidence remains stable

M60 deliberately does **not** invalidate or rewrite historical M59 bindings when a root is retired or revoked.

A historical binding still records:

- the exact snapshot ID;
- the exact snapshot digest;
- the anchor verification outcome at binding time.

Governance answers a different question: whether that root set is allowed to authorize a **new** binding now.

This distinction keeps historical verification reproducible while allowing current trust to evolve safely.

## Concurrency

Retirement and revocation use optimistic revisions.

For example, if the current revision is `2`, a request carrying `expectedRevision: 1` fails with `ConcurrencyError` and no governance event is written.

## Storage contract

M60 introduces:

- `RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceStore`;
- a detached reference in-memory implementation;
- create-only governance events;
- deterministic per-snapshot history ordering.

Production adapters can persist the same contract in SQL, document, ledger or event-store infrastructure without changing the core governance semantics.

## Non-goals

M60 does not:

- mutate M59 root snapshots;
- delete historical root snapshots;
- delete historical anchor/root bindings;
- manage private keys or certificate stores;
- perform KMS/HSM operations;
- schedule automatic rotation;
- infer compromise automatically.

Rotation and compromise detection remain external operational concerns that submit explicit governance transitions into the package.
