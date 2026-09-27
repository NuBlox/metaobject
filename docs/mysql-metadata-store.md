# MySQL metadata persistence

M71 adds a MySQL implementation of the public `MetadataStore` contract to `@nublox/metaobject-storage-mysql`.

## Package boundary

The implementation remains in the `NuBlox/metaobject` monorepo under `packages/storage-mysql`. Dependency direction remains one-way:

```text
@nublox/metaobject-storage-mysql
        |
        +--> @nublox/metaobject
        +--> @nublox/mysql
```

The core `@nublox/metaobject` package remains database-neutral and has no MySQL dependency.

## Table model

`MySqlMetadataStore` uses one InnoDB table keyed by:

```text
(object_type_id, object_type_version)
```

Columns persist:

- `status` — `draft`, `published` or `deprecated`;
- `revision` — optimistic metadata revision;
- `snapshot_json` — bounded/lossless normalized metadata envelope;
- `created_at` — exact MetaObject `createdAt` string;
- `updated_at` — exact MetaObject `updatedAt` string.

The snapshot is stored as `LONGTEXT` with `JSON_VALID(snapshot_json)`. This intentionally avoids MySQL native JSON member reordering because the current RC conformance suite compares normalized records in deterministic member order.

## Save semantics

A first save assigns revision `1`. An existing record can be changed only when the caller supplies the current expected revision. Successful updates increment the revision by one and preserve the original `createdAt` value.

Each save executes inside an InnoDB transaction and takes a `SELECT ... FOR UPDATE` lock on the metadata key before applying the revision check. The final update/delete statement also includes the revision predicate.

This provides both database locking and application-level optimistic concurrency.

## Batch semantics

`saveBatch()` validates all records and duplicate keys before entering the transaction. All writes then execute in one transaction and results preserve request order. A stale write causes the complete batch to roll back.

Transient MySQL deadlocks and lock-wait timeouts use `@nublox/mysql` transaction retry support. The default retry count is two and can be overridden through `MySqlMetadataStoreOptions.transaction`.

## Validation and tamper handling

Before SQL execution, the adapter validates:

- object type ID presence and MySQL key length;
- object type version range;
- metadata status;
- safe revision values;
- timestamp storage bounds;
- normalized snapshot root structure;
- snapshot object-type identity/version against the record key.

The M70 bounded lossless codec is reused for metadata snapshots. This means cyclic/accessor-backed/sparse/hostile values fail closed on write, while malformed persisted envelopes fail closed on read.

## Conformance and race testing

CI runs the published RC `runMetadataStoreConformance` suite against MySQL 8.4. Additional M71 tests cover:

- concurrent save/save at the same expected revision;
- concurrent save/delete at the same expected revision;
- direct database tampering of a semantically invalid snapshot envelope.

For both concurrency races exactly one operation is permitted to commit.

## Public API

```ts
import { createPool } from "@nublox/mysql/promise";
import { MySqlMetadataStore } from "@nublox/metaobject-storage-mysql";

const pool = createPool({ /* connection options */ });
const metadata = new MySqlMetadataStore(pool);
await metadata.initialize();
```

The package version introduced by M71 is `0.3.0`.
