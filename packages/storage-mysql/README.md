# @nublox/metaobject-storage-mysql

MySQL persistence for [`@nublox/metaobject`](../../README.md), implemented against the public `StorageAdapter` and `MetadataStore` contracts using the NuBlox [`@nublox/mysql`](https://www.npmjs.com/package/@nublox/mysql) client.

## Status

M78 stable-v1 adapter alignment. Version `0.8.0` targets the stable `@nublox/metaobject@1.0.0` contract and `@nublox/mysql@3.1.0-rc.1`.

The package remains inside the `NuBlox/metaobject` monorepo while the MetaObject core remains database-neutral and MySQL-free.

## Requirements

- Node.js 22 or newer
- MySQL 8.x
- `@nublox/metaobject@1.0.0`
- `@nublox/mysql@3.1.0-rc.1`

## Usage

```ts
import { createPool } from "@nublox/mysql/promise";
import {
  MySqlMetadataStore,
  MySqlStorageAdapter,
  compileMySqlObjectQueryPlan,
} from "@nublox/metaobject-storage-mysql";

const pool = createPool({
  host: "127.0.0.1",
  user: "root",
  password: "secret",
  database: "app",
  timezone: "Z",
  supportBigNumbers: true,
  bigNumberStrings: true,
});

const storage = new MySqlStorageAdapter(pool);
const metadata = new MySqlMetadataStore(pool);

await storage.initialize();
await metadata.initialize();

const plan = compileMySqlObjectQueryPlan(storage.tableName, {
  objectType: "example.item",
  where: [{ attribute: "status", operator: "eq", value: "open" }],
  limit: 25,
});

console.log(plan.pushedFilters.length, plan.residualFilters.length);
```

`initialize()` runs the versioned physical-schema migration engine before returning. Custom tables, migration-ledger/lock settings and transaction retry policies can be configured independently. Transient MySQL deadlock/lock-timeout failures retry twice by default through `@nublox/mysql`. Optimistic-concurrency failures are not retried as transient lock failures.

## Runtime object persistence

`MySqlStorageAdapter` stores runtime object snapshots in InnoDB keyed by `(object_type, object_id)` with optimistic object versions, atomic batches, detached reads and the public query contract.

The bounded lossless codec preserves `Date`, `BigInt`, `undefined`, `NaN`, infinities and negative zero while rejecting cycles, accessors, sparse arrays, malformed canonical values and hostile/tampered payloads.

## Metadata persistence

`MySqlMetadataStore` is backed by a separate InnoDB table keyed by `(object_type_id, object_type_version)` and implements optimistic metadata revisions, atomic ordered batches, deterministic filtering and fail-closed decoding.

The metadata envelope is stored as validated `LONGTEXT` rather than native MySQL `JSON`, preserving exact record-member order required by the stable-v1 conformance suite while retaining `JSON_VALID(...)` enforcement.

## M72 query pushdown

`MySqlStorageAdapter.query()` compiles the SQL-safe subset of `ObjectQuery` and executes it with NuBloxSQL server-side prepared statements through `PromisePool.execute()`.

The following predicates are pushed into MySQL while preserving the stable-v1 `StorageAdapter` semantics:

- `eq` and `neq` for persisted primitive values, including `undefined`, `null`, booleans, strings, finite numbers, `NaN`, infinities, negative zero and `BigInt`;
- `in` and `notIn` using the same `Object.is` semantics as the reference adapter;
- `isNull` and `isNotNull`, including the distinction between absent attributes, encoded `undefined` and encoded `null`.

When every filter is SQL-safe and no attribute sort is requested, non-negative safe-integer `limit`/`offset` pagination is also pushed into MySQL.

Every attribute JSON path is supplied as a bound prepared-statement parameter. Attribute names are never interpolated into SQL text. The adapter decodes returned rows and reapplies the original predicates as a semantic defence-in-depth check.

### Deliberate fallback boundary

The following remain in JavaScript for stable-v1 compatibility:

- `gt`, `gte`, `lt`, `lte`;
- `contains`, `startsWith`, `endsWith`;
- attribute `orderBy`.

The core reference adapter currently uses JavaScript `localeCompare()` for string and mixed-type comparison. MySQL collation ordering is not guaranteed to be equivalent. M72 therefore prefers a correct fallback over a faster but observably different SQL result. A future core comparison contract can make those semantics deterministic enough for broader pushdown.

`compileMySqlObjectQueryPlan()` is exported for diagnostics and tests. It reports the generated prepared SQL, parameters, pushed filters, residual filters and whether pagination was pushed.

## M73 schema evolution

The object and metadata physical schemas are both at version `2` and are managed by an append-only migration ledger. Version `1` remains the immutable pre-M73 baseline; version `2` adds composite indexes used by object/metadata lookup paths.

M73 provides:

- SHA-256 migration-definition checksums;
- contiguous-version and newer-than-supported guards;
- automatic adoption of structurally valid pre-M73 version-1 tables;
- idempotent crash recovery when DDL committed before its ledger row was written;
- a dedicated MySQL named advisory lock for each database/component/target-table migration stream;
- structural verification through `information_schema` for engine, collation, required columns/types/nullability and required indexes;
- fail-closed rejection of migration-ledger tampering and required-schema drift.

MySQL DDL is **not** treated as one rollbackable transaction. M73 relies on serialized initialization, MySQL's atomic DDL guarantees for individual operations, post-DDL verification and recoverable ledger reconciliation.

Migration configuration is available through adapter/store options:

```ts
const storage = new MySqlStorageAdapter(pool, {
  migrations: {
    migrationTableName: "metaobject_schema_migrations",
    lockTimeoutSeconds: 30,
  },
});
```

The infrastructure functions are also exported directly:

```ts
await migrateMySqlStorageSchema(pool);
await migrateMySqlMetadataSchema(pool);
```

See [`../../docs/mysql-schema-migrations.md`](../../docs/mysql-schema-migrations.md) for the complete lifecycle and failure model.

## M74 certification and stress hardening

M74 adds an executable certification gate above the focused conformance suite. It certifies the adapter with:

- a deterministic 1,200-object corpus compared query-for-query with the core `MemoryStorageAdapter` reference implementation;
- 16 query shapes spanning pushed equality/membership/null predicates, pagination and residual range/string/order semantics;
- 400 concurrent reads through a four-connection pool, followed by health/queue/connection-return assertions;
- 32 concurrent object writers and 32 concurrent metadata writers against one version/revision, requiring one winner and `ConcurrencyError` for every loser;
- object and metadata batch rollback probes where multiple valid writes execute before an intentional stale write;
- 16 concurrent `initialize()` calls against one migration stream using a six-connection pool, requiring one ledger row per schema version;
- broad elapsed-time regression guardrails plus machine-readable `M74_CERTIFICATION` evidence lines.

Run the live certification locally with:

```bash
npm run test:live
```

See [`../../docs/mysql-m74-certification.md`](../../docs/mysql-m74-certification.md) for the acceptance model, thresholds and evidence boundary.

## M75 external-consumer release qualification

M75 verifies the packed adapter from a completely separate temporary project instead of relying only on repository-local imports.

The clean-consumer gate packs the package, installs that tarball with lifecycle scripts disabled, resolves the declared published NuBlox dependencies from npm, runs an ESM runtime import probe, and compiles a strict `NodeNext` TypeScript consumer against the public package declarations.

CI runs this clean-consumer gate on Node.js 22 and 24. The live persistence/certification job also runs independently against MySQL 8.0 and MySQL 8.4.

Run repository-local release qualification with:

```bash
npm run release:check
```

With `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD` and `MYSQL_DATABASE` configured, run the complete package + live database qualification with:

```bash
npm run release:check:live
```

See [`../../docs/mysql-m75-release-qualification.md`](../../docs/mysql-m75-release-qualification.md) for the exact release boundary and acceptance criteria.

## M78 stable-v1 alignment

M78 moves the adapter from the immutable RC-core dependency used by `0.7.0` to the published stable core without changing adapter runtime behaviour:

- package version `0.7.0` → `0.8.0`;
- `@nublox/metaobject` dependency `1.0.0-rc.1` → exact stable `1.0.0`;
- package verification fails closed if that stable dependency drifts;
- the packed clean-consumer gate reads the installed core package and requires exactly `1.0.0` before runtime and strict TypeScript checks execute;
- Node.js 22/24 clean-consumer qualification and MySQL 8.0/8.4 live certification remain mandatory.

M78 does not change object/metadata schema versions, codec formats, query semantics, migration history or public adapter exports. See [`../../docs/mysql-m78-stable-v1-alignment.md`](../../docs/mysql-m78-stable-v1-alignment.md).

## Conformance

CI executes both `runStorageAdapterConformance` and `runMetadataStoreConformance` against MySQL 8.0 and 8.4, followed by M70/M71 concurrency/tamper tests, M72 live query-equivalence cases, M73 migration fresh-install/upgrade/race/drift/tamper coverage and the M74 certification stress gate. Separate Node.js 22/24 jobs install the packed adapter into a clean external consumer and verify runtime plus TypeScript package-root consumption against stable `@nublox/metaobject@1.0.0`.

## Publication

Version `0.8.0` is published only from an exact green `main` commit. The immutable tag:

```text
storage-mysql-v0.8.0
```

triggers `.github/workflows/publish-storage-mysql.yml`, which verifies tag/version/main ancestry, reruns `release:check`, authenticates through npm trusted publishing and publishes explicitly with `--access public --tag next`.

Published versions are immutable; fixes after publication require a new version. Existing `0.7.0` is not republished or mutated.

## License

Apache-2.0. Copyright 2026 Stephen J T Spittal.
