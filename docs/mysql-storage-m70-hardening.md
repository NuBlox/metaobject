# MySQL storage M70 hardening

M70 hardens `@nublox/metaobject-storage-mysql` after the M69 foundation proved the published `@nublox/metaobject@1.0.0-rc.1` `StorageAdapter` contract against MySQL 8.4.

The milestone does not add a new persistence abstraction. It strengthens the existing MySQL implementation at its trust, serialization and concurrency boundaries.

## Persistence-boundary validation

Before SQL execution the adapter now validates:

- object `type` and `id` are non-empty strings no longer than the backing `VARCHAR(255)` columns;
- `schemaVersion` is a non-negative integer within MySQL `INT UNSIGNED` range;
- update versions can be incremented without leaving JavaScript's safe-integer range;
- snapshot `values` and `relationships` are object records.

Invalid data therefore fails as a MetaObject metadata error rather than surfacing later as an opaque MySQL range/truncation error or an unreadable persisted row.

## Lossless codec hardening

The M69 versioned envelope remains the storage format. M70 makes its traversal and decoder fail closed:

- cyclic object graphs are rejected;
- sparse arrays are rejected;
- accessor-backed enumerable values are rejected without invoking getters;
- enumerable symbol-keyed data is rejected rather than silently discarded;
- non-plain object prototypes remain unsupported;
- nesting depth is bounded at 128 levels;
- total encoded/decoded node count is bounded at 100,000;
- canonical finite numbers, special numbers, BigInts and Dates are validated during decode;
- malformed/tampered encodings throw `MetadataError`;
- object member `__proto__` is created as an own data property and cannot mutate the decoded object's prototype.

The limits are defensive resource bounds, not domain-model limits. Future format revisions may make them configurable only if a concrete consumer requires that flexibility.

## Concurrency hardening

Optimistic concurrency remains a conditional SQL write using `(object_type, object_id, version)`.

M70 adds live MySQL tests proving:

1. two concurrent updates based on the same expected version produce exactly one committed writer and one `ConcurrencyError`;
2. concurrent update-versus-delete operations based on the same expected version also produce exactly one winner;
3. the winning update advances the stored version exactly once;
4. the losing operation never silently overwrites or resurrects the object.

`saveBatch` continues to run in one InnoDB transaction. It now defaults to two transient retries through `@nublox/mysql` for MySQL deadlock and lock-wait-timeout errors. The retry policy is configurable through `MySqlStorageAdapterOptions.transaction`. Optimistic-concurrency failures are not part of the default transient-retry set.

## Tamper handling

Integration coverage writes a syntactically valid but semantically invalid envelope directly to the backing table and verifies that `get()` rejects it. This proves the codec does not trust database contents merely because `JSON_VALID(...)` passed at storage time.

## Deferred work

M70 intentionally does not implement:

- SQL push-down of attribute predicates/order/pagination;
- metadata-store persistence;
- schema migration ledger/forward migrations;
- PostgreSQL/SQLite adapters;
- package publication of `@nublox/metaobject-storage-mysql`.

Those remain separate milestones so production-hardening changes stay reviewable and the database-neutral core remains frozen during RC soak.
