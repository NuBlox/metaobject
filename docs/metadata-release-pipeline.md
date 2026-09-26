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

The manager performs this sequence:

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
Re-read draft revision
      │
      ├── changed -> ABORT
      │
      ▼
Publish exact prepared revision
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
