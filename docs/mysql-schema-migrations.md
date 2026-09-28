# MySQL schema migrations (M73 + M79)

M73 introduced explicit, versioned physical-schema evolution to `@nublox/metaobject-storage-mysql` without introducing MySQL concerns into the database-neutral `@nublox/metaobject` core. M79 extends that same append-only migration stream to physical schema version 3 so MySQL identity equality matches the stable-v1 JavaScript reference stores.

## Scope

The migration layer owns the adapter's physical object-storage and metadata-storage tables. It does **not** migrate MetaObject business metadata or runtime object-type definitions; those remain governed by the core metadata/schema-evolution APIs.

Current physical schema versions are:

- object storage: version `3`;
- metadata storage: version `3`.

The immutable sequence is:

- version `1` — M69–M72 baseline tables;
- version `2` — query-supporting composite indexes;
- version `3` — exact binary/no-pad identity collations.

Version 2 adds:

- object storage: `(object_type, schema_version, object_id)`;
- metadata storage: `(object_type_id, status, object_type_version)`.

Version 3 changes only identity-bearing columns:

- object storage `object_type` → `utf8mb4_0900_bin`;
- object storage `object_id` → `utf8mb4_0900_bin`;
- metadata storage `object_type_id` → `utf8mb4_0900_bin`.

The table default remains `utf8mb4_unicode_ci` for non-identity text.

## Migration ledger

The default ledger table is `metaobject_schema_migrations`. Each row is keyed by:

```text
(component, target_table, schema_version)
```

and records:

- migration identifier;
- SHA-256 checksum of the immutable migration definition;
- application timestamp.

Ledger history is append-only from the migration runner's perspective. Before any forward work, the runner requires versions to be contiguous from `1`, rejects versions newer than the adapter understands, and verifies each recorded migration identifier and checksum against the package's immutable migration catalogue.

This prevents a released migration from being silently rewritten later. M79 appends version 3; it does not modify the version-1 or version-2 definitions or checksums.

## Fresh installation and legacy adoption

Fresh tables and upgrades use the same ordered migration chain.

For a fresh object or metadata table the runner:

1. establishes and verifies the version-1 baseline;
2. records version 1;
3. applies/verifies the version-2 indexes;
4. records version 2;
5. applies/verifies the version-3 identity collation;
6. records version 3.

Existing pre-M73 tables do not have ledger rows. When their physical structure already satisfies an immutable migration, the runner **adopts** that migration by verifying the structure and then recording the corresponding ledger row instead of replaying the DDL.

The same mechanism makes DDL/ledger interruption recoverable. If MySQL committed DDL but the process stopped before the ledger row was written, the next run detects that the migration is already structurally satisfied, verifies it, and records it as adopted.

An existing v2 database therefore adopts/validates versions 1 and 2 and executes only version 3. A v1 database adopts version 1 and executes versions 2 and 3.

`MySqlSchemaMigrationReport` distinguishes newly executed `appliedVersions` from structurally verified `adoptedVersions`.

## Concurrency control

MySQL schema DDL is not treated as one cross-migration transaction. MySQL performs implicit commits around many DDL operations.

The runner instead uses a dedicated pooled connection and a MySQL named advisory lock (`GET_LOCK`) derived from:

```text
database + schema component + target table
```

The lock is held across ledger reconciliation, DDL execution, structural verification and ledger recording. A second initializer for the same component/table waits for the first, then re-reads the ledger and physical schema before doing any work.

The default lock timeout is 30 seconds and can be configured with `lockTimeoutSeconds`. If lock release cannot be confirmed, the connection is destroyed rather than returned to the pool with uncertain lock ownership.

## Structural drift detection

Before adopting or finalizing a migration, the runner checks `information_schema` for required invariants, including:

- InnoDB storage engine;
- `utf8mb4_unicode_ci` table default collation;
- required column names;
- required MySQL column types;
- required nullability;
- explicit identity-column collations where required by the current schema;
- required named indexes;
- exact ordered index columns and uniqueness.

For schema version 3, `COLLATION_NAME` must be `utf8mb4_0900_bin` for `object_type`, `object_id` and `object_type_id` as applicable. A later manual change back to a case-insensitive or PAD SPACE collation therefore fails closed during initialization.

Additional columns or indexes are tolerated so application-owned extensions are not removed automatically. A required structure that has been changed or replaced fails closed with a `MetadataError` describing the drift.

The migration-ledger table is subject to the same baseline structural checks.

## Why `utf8mb4_0900_bin`

MetaObject's in-memory reference implementations use JavaScript string identity for storage and metadata keys. Case changes and trailing spaces therefore produce distinct identities.

MySQL documents `utf8mb4_0900_bin` as a binary `utf8mb4` collation with the `NO PAD` attribute. `NO PAD` comparisons preserve trailing-space significance, unlike older `PAD SPACE` collations such as `utf8mb4_bin`. Combined with binary comparison, this gives the supported MySQL 8.x adapter an identity rule aligned with the reference-store contract.

See [`mysql-m79-exact-identity.md`](mysql-m79-exact-identity.md) for the M79 correctness rationale and regression matrix.

## Public API

Both adapter initialization paths run migrations automatically:

```ts
const storage = new MySqlStorageAdapter(pool);
await storage.initialize();

const metadata = new MySqlMetadataStore(pool);
await metadata.initialize();
```

Migration behaviour can be configured independently:

```ts
const storage = new MySqlStorageAdapter(pool, {
  migrations: {
    migrationTableName: "metaobject_schema_migrations",
    lockTimeoutSeconds: 30,
  },
});
```

The runner is also exported directly for infrastructure/provisioning workflows:

```ts
await migrateMySqlStorageSchema(pool);
await migrateMySqlMetadataSchema(pool);
```

## Failure and recovery model

The migration engine is designed to fail closed:

- incompatible physical schema → reject;
- non-contiguous ledger → reject;
- migration identifier/checksum mismatch → reject;
- database schema newer than the installed adapter → reject;
- required identity collation drift → reject;
- advisory-lock timeout → reject;
- inability to verify the post-migration structure → reject and do not record the migration.

Because each DDL step is independently verifiable and migration recording follows structural verification, re-running after an interruption converges safely without pretending MySQL DDL is transactionally rollbackable as a group.

## Verification

The live MySQL 8.0 and 8.4 gates cover:

- fresh v1 → v2 → v3 installation;
- idempotent re-initialization;
- adoption and upgrade of legacy version-1 object storage;
- adoption and upgrade of legacy version-2 object storage;
- adoption and upgrade of legacy version-1 metadata storage;
- adoption and upgrade of legacy version-2 metadata storage;
- exact identity-column collation inspection;
- case-sensitive and trailing-space-sensitive object/metadata identities;
- concurrent initializers targeting the same table with one ledger row per version;
- structural drift rejection;
- migration-ledger checksum tamper rejection;
- all prior `StorageAdapter`, `MetadataStore`, concurrency, tamper, M72 query-pushdown and M74 stress-certification tests.
