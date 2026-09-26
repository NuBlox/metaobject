# Metadata release pipeline

M9 coordinates the previously separate metadata lifecycle, schema-evolution and code-generation capabilities into one release workflow.

`MetadataReleaseManager` does not execute database-specific SQL itself. It determines what must happen, enforces release gates, delegates blocking physical/data work through `MigrationExecutor`, publishes the metadata, and returns reproducible release artifacts.

## Initial publication

A first version has no previous published version and therefore no migration plan:

```ts
const manager = new MetadataReleaseManager(catalog);

await catalog.saveDraft(definitionV1);
const release = await manager.release(definitionV1.id, 1);
```

The release publishes the draft and returns the default artifact set:

- TypeScript model module
- generated TypeScript validator
- JSON Schema
- normalized metadata snapshot

## Upgrade preparation

Use `prepare()` to inspect a release before executing it:

```ts
const preparation = await manager.prepare("example.asset", 2);

console.log(preparation.diff?.impact);
console.log(preparation.migrationPlan?.steps);
console.log(preparation.artifacts);
```

Preparation captures the target draft revision. This revision becomes an optimistic release lock: if the draft changes while migration work is running, publication is aborted and must be prepared again.

## Batch releases

Mutually dependent object types must sometimes be activated together. `prepareMany()` and `releaseMany()` coordinate the whole metadata graph while preserving per-type diff and migration plans.

```ts
const batch = await manager.releaseMany([
  { objectTypeId: "example.team", targetVersion: 2 },
  { objectTypeId: "example.person", targetVersion: 3 },
]);
```

Batch release:

- rejects duplicate object type ids in the same batch
- prepares each target against its own latest published version
- aggregates generated artifacts
- aggregates blocking migration work and breaking-change review requirements
- executes blocking migration steps in deterministic request/plan order
- rechecks every draft revision before publication
- calls `MetadataCatalog.publishMany()` so bidirectional relationships and other cross-type dependencies are validated as one runtime graph

This is required for first publication of mutually referencing schemas where publishing either member alone would fail relationship validation.

## Compatible upgrades

Compatible schema changes can publish without a migration executor:

```ts
await manager.release("example.asset", 2);
```

Non-blocking `apply-metadata` migration steps are satisfied by publication itself.

## Migration-required upgrades

Changes such as backfills, index changes, or validation of existing data produce blocking migration steps.

The release is rejected unless a `MigrationExecutor` is provided:

```ts
await manager.release("example.asset", 3, {
  migrationExecutor: {
    async execute(step, context) {
      await applyPhysicalMigration(step, context);
    },
  },
});
```

The core package supplies the semantic step. A storage adapter or hosting application performs the physical work.

## Breaking upgrades

Breaking changes require explicit approval:

```ts
await manager.release("example.asset", 4, {
  approveBreaking: true,
});
```

Without `approveBreaking: true`, any migration plan containing a `manual-review` step is blocked.

Explicit approval does not bypass other blocking migration work. If the plan also contains executable blocking steps, a `MigrationExecutor` is still required.

## Concurrency protection

The manager performs this sequence for every release target:

```text
Read draft revision
      │
      ▼
Compare with latest published version
      │
      ▼
Build migration plan
      │
      ▼
Execute blocking migration steps
      │
      ▼
Re-read every draft revision
      │
      ├── any changed -> ABORT BATCH
      │
      ▼
Publish exact prepared revision(s)
```

This prevents a migration calculated for one draft from publishing a different draft that changed during the release window.

## Artifact selection

The default release generators are:

```text
typescript
typescript-validator
json-schema
metadata-snapshot
```

Callers can provide a smaller or adapter-extended set:

```ts
await manager.release("example.asset", 2, {
  artifactGenerators: ["json-schema", "mysql"],
  migrationExecutor: mysqlExecutor,
});
```

For this to work, the supplied `ArtifactGeneratorRegistry` must contain the adapter-specific generator.

## MySQL adapter integration

The intended M5 adapter flow is:

```text
@nublox/metaobject
  MetadataReleaseManager
        │
        ├── semantic SchemaDiff
        ├── portable MigrationPlan
        └── portable generated artifacts
                 │
                 ▼
@nublox/metaobject-storage-mysql
        ├── registers MySQL artifact generators
        ├── registers MySQL migration planning hooks
        └── implements MigrationExecutor
                 │
                 ▼
              MySQL
```

This preserves the database-neutral core while giving the MySQL package a complete integration surface for migrations and generated DDL.
