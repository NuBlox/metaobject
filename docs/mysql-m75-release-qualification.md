# M75 MySQL adapter external-consumer and release qualification

M75 moves `@nublox/metaobject-storage-mysql` from repository-local certification to release qualification as an independently consumable npm package.

The milestone applies to adapter version `0.7.0` and keeps the core package pinned to the already-published `@nublox/metaobject@1.0.0-rc.1` public contract.

## Qualification boundary

M75 verifies four distinct boundaries:

1. the adapter can be packed with only its intended public payload;
2. that tarball can be installed into a completely separate consumer project while its declared NuBlox dependencies resolve from the public npm registry;
3. runtime ESM imports and TypeScript declarations work from the package root without monorepo-relative paths or source-tree assumptions;
4. the existing M69-M74 persistence/concurrency/migration/certification suite passes on both MySQL 8.0 and MySQL 8.4.

This is deliberately different from testing source files in the repository that produced the package.

## Clean external consumer gate

`packages/storage-mysql/scripts/verify-consumer.mjs` creates a temporary project, packs the current adapter, installs that tarball with lifecycle scripts disabled, and validates the installed artifact from outside the repository.

The consumer proves:

- `@nublox/metaobject-storage-mysql` resolves from its package root;
- its declared `@nublox/metaobject@1.0.0-rc.1` dependency resolves from npm;
- its declared `@nublox/mysql@3.1.0-rc.1` dependency resolves from npm;
- the MetaObject public API generation remains `"1"`;
- the exported MySQL object and metadata schema versions remain the expected v2 schemas;
- `compileMySqlObjectQueryPlan()` is usable at runtime from the packed package;
- `MySqlStorageAdapter` remains assignable to the core `StorageAdapter` contract;
- `MySqlMetadataStore` remains assignable to the core `MetadataStore` contract;
- TypeScript resolves the package declarations under strict `NodeNext` compilation.

The temporary consumer is destroyed after each run.

Run it from `packages/storage-mysql`:

```bash
npm run verify:consumer
```

## Node.js consumer matrix

CI executes the clean-consumer gate on:

- Node.js 22;
- Node.js 24.

The adapter's `engines` field therefore remains `>=22` while the core package continues to support Node.js 20, 22 and 24 independently.

## MySQL version matrix

The live persistence job now runs independently against:

- MySQL 8.0;
- MySQL 8.4.

Each MySQL lane runs:

```bash
npm run check
npm run test:integration
npm run test:certification
```

That means every supported database lane covers:

- object persistence and codec hardening;
- metadata persistence and optimistic revisions;
- atomic object and metadata batches;
- query pushdown/fallback equivalence;
- migration install/upgrade/race/drift/tamper handling;
- the M74 1,200-object semantic-equivalence corpus;
- pooled parallel reads;
- high-contention object and metadata optimistic concurrency;
- rollback after partial transactional progress;
- migration stampede serialization.

## Release commands

Repository-local package qualification:

```bash
npm run release:check
```

This runs typechecking, unit tests, package-manifest verification and the clean external consumer installation.

With a reachable MySQL 8.x database configured through `MYSQL_*` environment variables, the complete qualification gate is:

```bash
npm run release:check:live
```

That adds the complete live integration and M74 certification workloads.

## Publication boundary

M75 does **not** automatically publish `@nublox/metaobject-storage-mysql`.

Publication remains a deliberate release action after the exact commit being released has passed the M75 gate. The intended first publication command is:

```bash
npm publish --access public --tag next
```

The package version is immutable after publication. If a defect is found after publishing `0.7.0`, fix it in a new package version rather than attempting to replace the published tarball.

## Core-release implication

M75 is intentionally designed to detect accidental reliance on unpublished core internals. The adapter's clean consumer uses the published MetaObject RC rather than a local source checkout. If the adapter passes M75 without requiring a change to the core public contract, that is positive evidence that `@nublox/metaobject@1.0.0-rc.1` remains externally consumable as designed.

A failure that can only be repaired by changing the v1 core public contract would require a new core release candidate. Adapter-only defects do not require a core RC increment.

## Acceptance criteria

M75 is complete only when all of the following are true on the same adapter revision:

- package manifest verification passes;
- clean external runtime import passes on Node.js 22 and 24;
- clean external TypeScript compilation passes on Node.js 22 and 24;
- MySQL 8.0 live conformance/integration/certification passes;
- MySQL 8.4 live conformance/integration/certification passes;
- core Node.js 20/22/24 CI remains green;
- no core v1 public-contract modification is required.

Passing M75 qualifies the adapter revision for an explicit npm release operation; it does not itself perform that operation.
