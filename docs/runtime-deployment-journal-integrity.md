# Append-only runtime deployment journal integrity

M20 strengthens the M19 deployment journal from a well-formed audit sequence into an append-only persistence contract.

M19 validated each candidate journal independently. A malformed sequence such as `1, 3, 4` was rejected, but a storage implementation could still accept another internally valid journal that removed or rewrote previously committed entries.

M20 closes that gap.

## Persistence invariant

For an existing deployment record:

```text
current journal = [E1, E2, E3]
```

an update may persist only:

```text
[E1, E2, E3]
```

or:

```text
[E1, E2, E3, E4, ...]
```

It may not persist:

```text
[E1, E2]                 truncate
[E1*, E2, E3]            rewrite
[E2, E1, E3]             reorder/rewrite
undefined                 remove
```

This rule applies even when the proposed replacement is itself a perfectly valid 1-based journal.

## Core guard

The package exports:

```ts
assertRuntimeDeploymentJournalAppendOnly(current, next);
```

The guard compares the complete previously committed prefix against the proposed journal.

Existing entries are compared structurally, including nested evidence. The comparison handles ordinary objects and arrays as well as `Date`, `Uint8Array`, `ArrayBuffer`, `Map` and `Set` values that may appear inside structured execution evidence.

Therefore changing a nested evidence field on an old event is treated exactly like changing its event kind or timestamp: the save is rejected.

## Reference-store enforcement

`MemoryRuntimeDeploymentStore.save()` now applies the checks in this order:

```text
validate candidate journal shape
        ↓
check optimistic expected revision
        ↓
assert existing journal prefix is unchanged
        ↓
persist
```

The revision check deliberately precedes append-only comparison against the current record. A stale writer therefore receives the concurrency conflict first rather than an integrity error based on state it no longer owns.

## Legacy records

M17/M18 records may not contain a journal at all. M19 kept the field optional for that reason.

M20 preserves this migration path:

```text
legacy current journal = undefined
              ↓
next save may establish [E1, ...]
```

Once at least one journal entry has been persisted, however, the journal cannot be removed or rewritten.

## SQL adapter obligation

Database-backed `RuntimeDeploymentStore` implementations must enforce the same semantic contract.

A normalized relational representation should preferably make rewriting impossible by design:

```text
runtime_deployment_journal
──────────────────────────
deployment_id
sequence
kind
occurred_at
...

PRIMARY KEY (deployment_id, sequence)
```

An update transaction should:

1. lock/check the deployment revision;
2. leave all existing journal rows untouched;
3. insert only newly appended sequence rows;
4. update the deployment state/revision;
5. commit journal additions and state atomically.

The exported append-only guard is still useful for adapter input validation, but the physical schema/transaction should provide the final enforcement against cross-process races.

## Security and audit scope

Append-only application semantics prevent normal package/store APIs from editing history. They do not by themselves make a compromised database administrator or raw storage medium cryptographically unable to alter records.

If tamper-evident or independently verifiable audit history is required, a later layer can add hash chaining/signatures or an external immutable audit sink without changing the M19/M20 event semantics.
