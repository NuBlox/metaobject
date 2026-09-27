# @nublox/metaobject-storage-mysql

MySQL persistence for [`@nublox/metaobject`](../../README.md), implemented against the public `StorageAdapter` and `MetadataStore` contracts using the NuBlox [`@nublox/mysql`](https://www.npmjs.com/package/@nublox/mysql) client.

## Status

M71 MySQL metadata persistence. Version `0.3.0` targets `@nublox/metaobject@1.0.0-rc.1` and `@nublox/mysql@3.1.0-rc.1`.

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
```

Custom tables and transaction retry policies can be configured independently:

```ts
const metadata = new MySqlMetadataStore(pool, {
  tableName: "tenant_42_metadata",
  transaction: {
    maxRetries: 3,
    retryDelayMs: 25,
    maxRetryDelayMs: 500,
  },
});
```

Transient MySQL deadlock/lock-timeout failures retry twice by default through `@nublox/mysql`. Optimistic-concurrency failures are not retried as transient lock failures.

## Runtime object persistence

`MySqlStorageAdapter` stores runtime object snapshots in InnoDB keyed by `(object_type, object_id)` with optimistic object versions, atomic batches, detached reads and the public query contract.

The bounded lossless codec preserves `Date`, `BigInt`, `undefined`, `NaN`, infinities and negative zero while rejecting cycles, accessors, sparse arrays, malformed canonical values and hostile/tampered payloads.

## Metadata persistence

M71 adds `MySqlMetadataStore`, backed by a separate InnoDB table keyed by `(object_type_id, object_type_version)`.

Each record stores:

- metadata status (`draft`, `published`, `deprecated`);
- an optimistic `revision`;
- the normalized metadata snapshot in the same bounded lossless envelope used by object persistence;
- exact `createdAt` and `updatedAt` strings from the MetaObject contract.

The metadata envelope is stored as validated `LONGTEXT` rather than native MySQL `JSON`, preserving exact record-member order required by the current RC conformance suite while retaining `JSON_VALID(...)` enforcement.

### Metadata guarantees

`MySqlMetadataStore` implements the complete RC `MetadataStore` contract:

- first save assigns revision `1`;
- existing records require the matching expected revision;
- updates increment revision and preserve the original `createdAt`;
- `saveBatch` is atomic, ordered and duplicate-key guarded;
- list filtering by object type/status is deterministic;
- delete is optimistic and missing delete is idempotent;
- reads are detached;
- metadata identity/version is checked against the normalized snapshot;
- write transactions use row locking plus optimistic revision predicates;
- concurrent save/save and save/delete races have exactly one winner;
- semantically tampered stored snapshots fail closed during reads.

CI executes both `runStorageAdapterConformance` and `runMetadataStoreConformance` against MySQL 8.4, followed by the M70/M71 race and tamper tests.

## Query strategy

Runtime `query()` currently restricts by object type in SQL and applies attribute predicates/order/pagination after decoding snapshots. SQL predicate/order/pagination push-down belongs to the later query-translation milestone.

## Schema evolution

Both object and metadata tables are currently schema version `1` and are created idempotently. A versioned migration ledger and forward migration runner remain a later milestone.

## License

Apache-2.0. Copyright 2026 Stephen J T Spittal.
