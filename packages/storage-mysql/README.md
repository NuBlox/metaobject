# @nublox/metaobject-storage-mysql

MySQL persistence for [`@nublox/metaobject`](../../README.md), implemented against the public `StorageAdapter` and `MetadataStore` contracts using the NuBlox [`@nublox/mysql`](https://www.npmjs.com/package/@nublox/mysql) client.

## Status

M72 safe MySQL query pushdown. Version `0.4.0` targets `@nublox/metaobject@1.0.0-rc.1` and `@nublox/mysql@3.1.0-rc.1`.

The package remains inside the `NuBlox/metaobject` monorepo while the MetaObject core remains database-neutral and MySQL-free.

## Requirements

- Node.js 22 or newer
- MySQL 8.x
- `@nublox/metaobject@1.0.0-rc.1`
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

Custom tables and transaction retry policies can be configured independently. Transient MySQL deadlock/lock-timeout failures retry twice by default through `@nublox/mysql`. Optimistic-concurrency failures are not retried as transient lock failures.

## Runtime object persistence

`MySqlStorageAdapter` stores runtime object snapshots in InnoDB keyed by `(object_type, object_id)` with optimistic object versions, atomic batches, detached reads and the public query contract.

The bounded lossless codec preserves `Date`, `BigInt`, `undefined`, `NaN`, infinities and negative zero while rejecting cycles, accessors, sparse arrays, malformed canonical values and hostile/tampered payloads.

## Metadata persistence

`MySqlMetadataStore` is backed by a separate InnoDB table keyed by `(object_type_id, object_type_version)` and implements optimistic metadata revisions, atomic ordered batches, deterministic filtering and fail-closed decoding.

The metadata envelope is stored as validated `LONGTEXT` rather than native MySQL `JSON`, preserving exact record-member order required by the current RC conformance suite while retaining `JSON_VALID(...)` enforcement.

## M72 query pushdown

`MySqlStorageAdapter.query()` now compiles the SQL-safe subset of `ObjectQuery` and executes it with NuBloxSQL server-side prepared statements through `PromisePool.execute()`.

The following predicates are pushed into MySQL while preserving the RC `StorageAdapter` semantics:

- `eq` and `neq` for persisted primitive values, including `undefined`, `null`, booleans, strings, finite numbers, `NaN`, infinities, negative zero and `BigInt`;
- `in` and `notIn` using the same `Object.is` semantics as the reference adapter;
- `isNull` and `isNotNull`, including the distinction between absent attributes, encoded `undefined` and encoded `null`.

When every filter is SQL-safe and no attribute sort is requested, non-negative safe-integer `limit`/`offset` pagination is also pushed into MySQL.

Every attribute JSON path is supplied as a bound prepared-statement parameter. Attribute names are never interpolated into SQL text. The adapter decodes returned rows and reapplies the original predicates as a semantic defence-in-depth check.

### Deliberate fallback boundary

The following remain in JavaScript for this RC-compatible milestone:

- `gt`, `gte`, `lt`, `lte`;
- `contains`, `startsWith`, `endsWith`;
- attribute `orderBy`.

The core reference adapter currently uses JavaScript `localeCompare()` for string and mixed-type comparison. MySQL collation ordering is not guaranteed to be equivalent. M72 therefore prefers a correct fallback over a faster but observably different SQL result. A future core comparison contract can make those semantics deterministic enough for broader pushdown.

`compileMySqlObjectQueryPlan()` is exported for diagnostics and tests. It reports the generated prepared SQL, parameters, pushed filters, residual filters and whether pagination was pushed.

## Conformance

CI executes both `runStorageAdapterConformance` and `runMetadataStoreConformance` against MySQL 8.4, followed by M70/M71 concurrency/tamper tests and M72 live query-equivalence cases.

## Schema evolution

Both object and metadata tables are currently schema version `1` and are created idempotently. A versioned migration ledger and forward migration runner remain a later milestone.

## License

Apache-2.0. Copyright 2026 Stephen J T Spittal.
