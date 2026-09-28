# M79 exact MySQL identity semantics

M79 closes a persistence-contract mismatch between the stable MetaObject v1 reference stores and the MySQL adapter.

## Problem

The reference `MemoryStorageAdapter` and `MemoryMetadataStore` use JavaScript string identity. Object type IDs, object IDs and metadata object-type IDs are therefore case-sensitive and preserve trailing spaces.

The pre-M79 MySQL physical schemas inherited `utf8mb4_unicode_ci` for those key columns. That collation is not an exact match for the reference identity contract: case variants can compare equal, and PAD SPACE semantics can make trailing spaces insignificant.

Examples that must remain distinct are:

```text
Identity.Type
identity.type

Key
key
Key 
```

M79 treats this as a correctness issue rather than an application naming convention.

## Schema version 3

M79 advances both physical schemas from version `2` to version `3`:

- object storage: `object_type` and `object_id` use `utf8mb4_0900_bin`;
- metadata storage: `object_type_id` uses `utf8mb4_0900_bin`.

The table default remains `utf8mb4_unicode_ci` for non-identity text. Only identity-bearing columns receive the exact binary, no-pad comparison rule.

MySQL documents `utf8mb4_0900_bin` as a binary `utf8mb4` collation with the `NO PAD` attribute. Under `NO PAD`, trailing spaces remain significant during nonbinary string comparison. The same collation is available in the supported MySQL 8.0 and 8.4 lines.

## Immutable forward migrations

M79 preserves the released migration history:

1. version 1 — original object/metadata table baseline;
2. version 2 — query-supporting composite indexes;
3. version 3 — exact identity-column collations.

The new forward migrations are:

```text
storage-0003-exact-identity-collation
metadata-0003-exact-identity-collation
```

Version-1 and version-2 migration definitions and checksums are unchanged. Existing databases therefore reconcile through the same append-only migration ledger rather than having historical DDL rewritten.

`initialize()` automatically upgrades an existing v2 table to v3. Existing v1 tables are adopted/upgraded through v1 → v2 → v3 in order.

## Drift detection

M79 extends structural inspection of `information_schema.COLUMNS` to include `COLLATION_NAME` where a column has an explicit identity-collation requirement.

After version 3, initialization fails closed if any of these required columns no longer use `utf8mb4_0900_bin`:

```text
storage.object_type
storage.object_id
metadata.object_type_id
```

This prevents a later manual DDL change from silently reintroducing case-insensitive or trailing-space-insensitive identity behaviour.

## Executable equivalence coverage

`test/mysql-identity.test.mjs` proves on live MySQL that the adapter can persist and independently retrieve:

- object types differing only by case;
- object IDs differing only by case;
- object IDs differing only by a trailing space;
- metadata object-type IDs differing only by case;
- metadata object-type IDs differing only by a trailing space.

The same test verifies that a lookup using a different case returns no record and that object-type/metadata filtering remains exact.

The migration suite additionally verifies:

- fresh v1 → v2 → v3 installation;
- v1 adoption followed by v2/v3 upgrade;
- v2 adoption followed by v3 upgrade;
- exact v3 column collations from `information_schema`;
- concurrent initialization with exactly one ledger row for each of versions 1, 2 and 3;
- prior drift and ledger-tamper protections.

The M74 migration-stampede certification gate now requires immutable ledger rows for all three physical-schema versions.

## Compatibility boundary

M79 changes only the MySQL adapter physical persistence layer.

It does **not** change:

- the stable `@nublox/metaobject@1.0.0` public API;
- `METAOBJECT_PUBLIC_API_VERSION`;
- runtime snapshot codec format;
- query filter semantics;
- metadata envelope format;
- optimistic-concurrency semantics;
- migration-ledger format;
- `@nublox/mysql@3.1.0-rc.1` dependency.

The adapter package advances to `@nublox/metaobject-storage-mysql@0.9.0` because schema version 3 adds new forward database behaviour while remaining compatible with stable MetaObject v1.

## Qualification

M79 is qualified through the existing eight-lane release matrix:

- core Node.js 20, 22 and 24;
- core package + clean consumer;
- packed MySQL adapter clean consumer on Node.js 22 and 24;
- full MySQL 8.0 persistence/conformance/certification;
- full MySQL 8.4 persistence/conformance/certification.

The live MySQL lanes execute the v3 upgrade and exact-identity regression coverage before the existing M74 stress gate.

## Release boundary

After the exact M79 `main` revision passes the full matrix, adapter `0.9.0` may be tagged as:

```text
storage-mysql-v0.9.0
```

The protected trusted-publishing workflow must rerun `release:check` and publish explicitly under npm `next`. Published `0.8.0` remains immutable.
