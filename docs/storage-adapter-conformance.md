# Storage and persistence adapter conformance

M64 defines executable compatibility contracts for external persistence implementations.

## Public conformance entrypoints

- `runStorageAdapterConformance()` validates implementations of `StorageAdapter`.
- `runMetadataStoreConformance()` validates implementations of `MetadataStore`.

Both functions create a fresh adapter/store for every check. External adapter packages should therefore provide a factory backed by a clean disposable database, schema, namespace, or transaction-isolated fixture.

## StorageAdapter requirements

The conformance suite verifies:

1. missing reads return `null`;
2. insert/get round-tripping and detached returned snapshots;
3. duplicate insert rejection without replacement;
4. optimistic update semantics and monotonic object versions;
5. atomic `saveBatch()` rollback and request-order results;
6. filter/order/offset/limit semantics of the portable `ObjectQuery` contract;
7. optimistic delete semantics and idempotent deletion of already-missing objects.

A database-backed adapter must provide the same externally observable behavior regardless of its internal schema or SQL dialect.

## MetadataStore requirements

The metadata-store suite verifies:

1. missing reads return `null`;
2. revision assignment, round-trip fidelity and detached reads;
3. optimistic revision checks and `createdAt` preservation;
4. atomic `saveBatch()` behavior and request-order results;
5. `objectTypeId` and `status` list filters;
6. optimistic delete semantics and idempotent deletion of already-missing records.

## External adapter boundary

Database-specific packages such as MySQL, PostgreSQL or SQLite adapters remain outside `@nublox/metaobject`. They may depend on database drivers, connection pools and dialect-specific DDL, but they must implement the public contracts exported by this package and run these conformance suites in their own CI.

`@nublox/metaobject` remains database-neutral and does not require any database client dependency.

## Transaction semantics

`saveBatch()` is an atomic contract, not a best-effort loop. SQL-backed implementations should use a database transaction. If any optimistic concurrency check or write fails, no write in the batch may remain committed.

## Version and revision semantics

Object persistence uses `ObjectSnapshot.version`; metadata persistence uses `MetadataRecord.revision`. Both are optimistic concurrency tokens. Implementations must reject stale writes rather than silently overwriting current state.

## Result ownership

Returned records and snapshots must be detached from mutable store state. Mutating a returned JavaScript object must not mutate persisted state without an explicit write operation.
