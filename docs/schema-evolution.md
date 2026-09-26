# Schema evolution

M8 adds semantic version-to-version comparison and database-neutral migration planning for metadata-defined object types.

The goal is to answer three separate questions explicitly:

1. **What changed?** — structural and behavioural metadata differences.
2. **How risky is it?** — compatible, migration-required, or breaking.
3. **What must happen before activation?** — ordered migration/validation steps that storage adapters can extend.

## Semantic diff

Use `diffObjectTypes()` to compare two versions of the same stable object type id:

```ts
const diff = diffObjectTypes(assetV1, assetV2);

console.log(diff.impact);
for (const change of diff.changes) {
  console.log(change.kind, change.path, change.impact, change.reason);
}
```

The target version must be greater than the source version.

### Impact levels

`compatible`
: Existing stored objects remain structurally valid and callers are not forced through a destructive conversion.

`requires-migration`
: Existing data or physical storage structures must be validated, backfilled, transformed, or rebuilt before the new schema is safely active.

`breaking`
: Existing data or public contracts cannot be assumed compatible. The default migration planner creates a blocking manual-review step.

The overall `SchemaDiff.impact` is the most severe impact among its individual changes.

## Compatibility examples

Typical **compatible** changes include:

- adding an optional attribute
- adding a computed attribute
- relaxing requiredness/nullability
- adding an operation or event
- changing display metadata while retaining the stable object type id

Typical **migration-required** changes include:

- adding a required attribute with a default that can backfill existing objects
- enabling uniqueness
- changing attribute constraints
- adding/changing/removing indexes
- adding or changing object validation rules
- changing an inverse relationship
- making an unordered collection ordered

Typical **breaking** changes include:

- removing an attribute or relationship
- changing an attribute type or multiplicity
- changing a relationship target or cardinality
- changing relationship ownership/composition semantics
- making an optional field required without a default
- tightening nullable to non-nullable without a backfill strategy
- changing a base type
- removing a declared operation or event

These rules are intentionally conservative. A domain-specific migration can make a breaking change safe, but core does not assume a conversion that metadata has not described.

## Migration planning

`MigrationPlanner` converts a semantic diff into an ordered `MigrationPlan`.

```ts
const planner = new MigrationPlanner();
const plan = planner.plan(diff);
```

Default step kinds include:

- `apply-metadata`
- `validate-existing-data`
- `backfill-existing-data`
- `transform-existing-data`
- `rebuild-index`
- `remove-obsolete-data`
- `manual-review`

Each step records whether it is blocking. Breaking changes produce blocking `manual-review` steps by default, and `MigrationPlan.requiresManualReview` is set accordingly.

## Adapter and application hooks

Adapters can add supplemental steps by semantic change kind:

```ts
planner.register("index-added", ({ change, ordinal }) => [{
  id: `mysql:${ordinal}:${change.path}`,
  kind: "mysql-ddl",
  path: change.path,
  description: "Create the physical MySQL index",
  blocking: true,
  changeKind: change.kind,
}]);
```

This preserves the package boundary:

```text
@nublox/metaobject
    semantic diff
    portable migration plan
          │
          ▼
@nublox/metaobject-storage-mysql
    MySQL DDL / data movement steps
```

The core understands object semantics, not SQL dialects.

## Persisted catalogue integration

`MetadataEvolution` connects the evolution engine to `MetadataCatalog`:

```ts
const evolution = new MetadataEvolution(catalog);

const diff = await evolution.diff("example.asset", 1, 2);
const plan = await evolution.plan("example.asset", 1, 2);
```

This lets schema-evolution decisions operate directly on versioned metadata records rather than requiring callers to manually load definitions.

## Recommended publication flow

A production publication pipeline should follow this sequence:

```text
Draft target metadata
        │
        ▼
Semantic diff against active version
        │
        ▼
Migration plan
        │
        ├── validate existing data
        ├── backfill / transform
        ├── rebuild indexes
        ├── adapter-specific physical changes
        └── manual approval for breaking changes
        │
        ▼
Publish target metadata
        │
        ▼
Regenerate M7 artifacts
        │
        ▼
Activate new runtime registry
```

M8 provides the portable diff and planning layer; transaction orchestration and database-specific execution belong to the hosting application and storage adapter.
