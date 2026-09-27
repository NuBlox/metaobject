# MySQL schema migrations (M73)

M73 adds explicit, versioned physical-schema evolution to `@nublox/metaobject-storage-mysql` without introducing MySQL concerns into the database-neutral `@nublox/metaobject` core.

## Scope

The migration layer owns the adapter's physical object-storage and metadata-storage tables. It does **not** migrate MetaObject business metadata or runtime object-type definitions; those remain governed by the core metadata/schema-evolution APIs.

Current physical schema versions are:

- object storage: version `2`;
- metadata storage: version `2`.

Version `1` is the immutable M69–M72 baseline. Version `2` adds query-supporting composite indexes:

- object storage: `(object_type, schema_version, object_id)`;
- metadata storage: `(object_type_id, status, object_type_version)`.

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

This prevents a released migration from being silently rewritten later.

## Fresh installation and legacy adoption

Fresh tables and upgrades use the same ordered migration chain.

For a fresh object or metadata table the runner:

1. establishes the version-1 baseline;
2. verifies the resulting structure;
3. records version 1;
4. applies version 2;
5. verifies the resulting structure;
6. records version 2.

Existing pre-M73 tables do not have ledger rows. When their physical structure already satisfies an immutable migration, the runner **adopts** that migration by verifying the structure and then recording the corresponding ledger row instead of replaying the DDL.

The same mechanism makes DDL/ledger interruption recoverable. If MySQL committed DDL but the process stopped before the ledger row was written, the next run detects that the migration is already structurally satisfied, verifies it, and records it as adopted.

`MySqlSchemaMigrationReport` distinguishes newly executed `appliedVersions` from structurally verified `adoptedVersions`.

## Concurrency control

MySQL schema DDL is not treated as one cross-migration transaction. MySQL performs implicit commits around many DDL operations.

M73 instead uses a dedicated pooled connection and a MySQL named advisory lock (`GET_LOCK`) derived from:

```text
database + schema component + target table
```

The lock is held across ledger reconciliation, DDL execution, structural verification and ledger recording. A second initializer for the same component/table waits for the first, then re-reads the ledger and physical schema before doing any work.

The default lock timeout is 30 seconds and can be configured with `lockTimeoutSeconds`. If lock release cannot be confirmed, the connection is destroyed rather than returned to the pool with uncertain lock ownership.

## Structural drift detection

Before adopting or finalizing a migration, the runner checks `information_schema` for required invariants, including:

- InnoDB storage engine;
- `utf8mb4_unicode_ci` table collation;
- required column names;
- required MySQL column types;
- required nullability;
- required named indexes;
- exact ordered index columns and uniqueness.

Additional columns or indexes are tolerated so application-owned extensions are not removed automatically. A required structure that has been changed or replaced fails closed with a `MetadataError` describing the drift.

The migration-ledger table is subject to the same structural checks.

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
- advisory-lock timeout → reject;
- inability to verify the post-migration structure → reject and do not record the migration.

Because each DDL step is independently verifiable and migration recording follows structural verification, re-running after an interruption converges safely without pretending MySQL DDL is transactionally rollbackable as a group.

## Verification

The MySQL 8.4 CI gate covers:

- fresh v1 → v2 installation;
- idempotent re-initialization;
- adoption and upgrade of legacy version-1 object storage;
- adoption and upgrade of legacy version-1 metadata storage;
- concurrent initializers targeting the same table;
- structural drift rejection;
- migration-ledger checksum tamper rejection;
- all prior `StorageAdapter`, `MetadataStore`, concurrency, tamper and M72 query-pushdown tests.
