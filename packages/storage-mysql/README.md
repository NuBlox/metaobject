# @nublox/metaobject-storage-mysql

MySQL persistence for [`@nublox/metaobject`](../../README.md), implemented against the public `StorageAdapter` contract and the NuBlox [`@nublox/mysql`](https://www.npmjs.com/package/@nublox/mysql) client.

## Status

M70 production persistence/concurrency hardening. Version `0.2.0` targets `@nublox/metaobject@1.0.0-rc.1` and `@nublox/mysql@3.1.0-rc.1`.

The package is intentionally separate from the MetaObject core runtime while remaining in the same `NuBlox/metaobject` repository. Core remains database-neutral and does not depend on MySQL.

## Requirements

- Node.js 22 or newer
- MySQL 8.x
- `@nublox/metaobject@1.0.0-rc.1`
- `@nublox/mysql@3.1.0-rc.1`

## Usage

```ts
import { createPool } from "@nublox/mysql/promise";
import { MySqlStorageAdapter } from "@nublox/metaobject-storage-mysql";

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
await storage.initialize();

// Pass `storage` anywhere the MetaObject `StorageAdapter` contract is expected.

await pool.end();
```

A custom table and transaction retry policy may be selected explicitly:

```ts
const storage = new MySqlStorageAdapter(pool, {
  tableName: "tenant_42_metaobjects",
  transaction: {
    maxRetries: 3,
    retryDelayMs: 25,
    maxRetryDelayMs: 500,
  },
});
```

Atomic batch transactions retry transient MySQL deadlock/lock-timeout failures twice by default through `@nublox/mysql`; callers may override the transaction options shown above. Optimistic-concurrency failures are not transient MySQL lock errors and are not retried by the default policy.

## Persistence model

The adapter uses one InnoDB table keyed by `(object_type, object_id)`:

- `schema_version` preserves the MetaObject schema revision bound to the snapshot;
- `version` implements optimistic object concurrency;
- `values_json` stores a versioned NuBlox value envelope as `LONGTEXT`;
- `relationships_json` stores the relationship snapshot using the same lossless `LONGTEXT` envelope;
- `JSON_VALID(...)` checks ensure both envelopes remain valid JSON;
- MySQL timestamps record row creation/update time without becoming part of the MetaObject snapshot contract.

The envelopes are deliberately stored as text rather than MySQL's native `JSON` type. MySQL normalizes JSON object member ordering, whereas the MetaObject RC conformance boundary requires an exact snapshot round trip including record member order. Validated text preserves the encoded order without weakening JSON validity.

The value codec preserves values that ordinary JSON would silently lose or coerce, including `Date`, `BigInt`, `undefined`, `NaN`, positive/negative infinity and negative zero.

## M70 hardening

M70 closes production-boundary gaps around object persistence and concurrency:

- object type/id lengths and schema-version range are validated before SQL execution;
- updates fail before overflow beyond JavaScript's safe-integer version range;
- cyclic object graphs, sparse arrays, accessor-backed values and enumerable symbol-keyed data fail closed;
- codec traversal is bounded by maximum depth and node count;
- malformed persisted `Date`, `BigInt` and canonical-number encodings fail closed on read;
- `__proto__` is decoded as ordinary own data without mutating object prototypes;
- `saveBatch` uses transient deadlock/lock-timeout retry support from `@nublox/mysql`;
- live MySQL tests prove that two writers sharing the same expected version have exactly one winner;
- live update-versus-delete races likewise have exactly one winner;
- deliberately tampered persisted envelopes are rejected during reads.

## Contract guarantees

The adapter implements the complete `StorageAdapter` surface from the RC:

- first insert persists version `1`;
- duplicate insert fails without replacement;
- update and delete use optimistic version checks;
- `saveBatch` is atomic using an InnoDB transaction and preserves request-result ordering;
- missing delete is idempotent;
- reads return detached snapshots;
- the legacy storage query contract supports filtering, ordering, offset and limit with semantics matching the in-memory reference adapter.

CI runs `runStorageAdapterConformance` from the published MetaObject RC against a real MySQL 8.4 service, then executes the additional M70 race/tamper tests.

## Query strategy

M69/M70 deliberately prioritize semantic equivalence over premature SQL translation. `query()` restricts by object type in SQL and applies attribute predicates/order/pagination after decoding snapshots.

SQL push-down for supported predicates, deterministic database ordering, pagination planning and indexes belong to the later query-translation milestone. Keeping this boundary explicit prevents MySQL-specific behavior from leaking into the core contract.

## Schema evolution

`initialize()` currently performs idempotent creation of storage schema version `1`. A versioned migration ledger and forward migration runner are intentionally deferred to the schema/migration milestone.

## License

Apache-2.0. Copyright 2026 Stephen J T Spittal.
