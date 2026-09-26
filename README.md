# @nublox/metaobject

A standalone, application-agnostic metadata-driven object model and runtime for TypeScript.

`@nublox/metaobject` turns object metadata into runtime objects with type enforcement, validation, relationships, change tracking, database-neutral querying, versioned metadata persistence, reproducible code generation, schema evolution planning and governed metadata releases. It has no dependency on NuBlox application products or on any database engine.

## Design principles

- **Metadata is the source of truth.** Object definitions describe attributes, types, relationships, constraints, behaviours and indexes.
- **Compile-time and runtime models coexist.** Literal metadata can infer TypeScript shapes; JSON/database metadata receives the same runtime validation.
- **Storage is pluggable.** Core exposes storage contracts rather than embedding MySQL, PostgreSQL or another database.
- **Relationships are first-class.** `ObjectGraph` coordinates bidirectional relationship semantics.
- **Behaviours remain serializable.** Metadata stores stable handler names; executable functions live in registries.
- **Queries are database-neutral.** Rich query planning sits above storage and can later be pushed down by adapters.
- **Metadata persistence is normalized.** Definitions flatten into database-ready metadata records.
- **Generated artifacts are reproducible.** TypeScript, validators, JSON Schema and adapter artifacts are regenerated from metadata rather than becoming a second source of truth.
- **Schema evolution is semantic.** Version changes are classified by compatibility and translated into portable migration plans.
- **Releases are gated.** Breaking changes, blocking migrations and optimistic draft revisions are enforced before publication.
- **Optimistic concurrency is explicit.** Runtime objects and metadata drafts use version/revision checks.

## Quick start

```ts
import {
  MemoryStorageAdapter,
  MetaObjectRepository,
  ObjectFactory,
  ObjectTypeRegistry,
  Validator,
  createDefaultTypeRegistry,
  defineObjectType,
} from "@nublox/metaobject";

const types = createDefaultTypeRegistry();
const objects = new ObjectTypeRegistry(types);

const Person = defineObjectType({
  id: "example.person",
  name: "Person",
  version: 1,
  attributes: {
    firstName: { type: "string", required: true },
    age: { type: "integer" },
  },
} as const);

objects.register(Person);

const factory = new ObjectFactory(objects, types);
const repository = new MetaObjectRepository(
  new MemoryStorageAdapter(),
  factory,
  new Validator(),
);

const person = factory.create(Person, { firstName: "Stephen", age: 41 });
await repository.save(person);
```

## Built-in attribute types

`string`, `integer`, `number`, `decimal`, `boolean`, `date`, `datetime`, `uuid`, `json`, and `binary` are included. Additional types implement `AttributeType<T>` and register through `TypeRegistry`.

## Relationship engine

M1 adds one-to-one, one-to-many, many-to-one and many-to-many relationships, inverse synchronization, ownership, ordering, required relationships, change tracking, graph navigation, referential integrity, batch persistence and explicit `restrict` / `cascade` / `detach` delete policies.

M2 adds single inheritance, abstract/sealed types, lineage, subtype-compatible relationships, aggregation, composition and exclusive composite-parent lifecycle semantics. See `docs/inheritance-composition.md`.

## Constraints and behaviours

M3 adds custom constraints, cross-field rules, severity-aware validation, computed attributes, operations, hooks, declared domain events and inherited behaviour metadata. Executable code stays in runtime registries while metadata remains serializable. See `docs/constraints-behaviors.md`.

## Query engine

M4 adds `MetaQuery`, `QueryPlanner` and `QueryEngine` while retaining the original flat `ObjectQuery` storage contract.

Supported capabilities include recursive `and` / `or` / `not`, metadata-validated relationship paths, projections, aliases, aggregates, stable cursor pagination, explicit null ordering and subtype expansion. See `docs/query-engine.md`.

## Metadata persistence

M6 provides a database-neutral normalized catalogue with `draft`, `published` and `deprecated` lifecycle states, optimistic revisions, batch publication of mutually-dependent schemas, portable bundle import/export and reconstruction of runtime registries.

`normalizeObjectType()` flattens definitions into row collections suitable for tables such as:

```text
meta_object_type
meta_attribute
meta_attribute_constraint
meta_relationship
meta_index
meta_index_attribute
meta_object_rule
meta_operation
meta_event
meta_hook
```

See `docs/metadata-persistence.md`.

## Code generation

M7 expands code generation into a reproducible artifact system.

```ts
const generators = createDefaultArtifactGeneratorRegistry();
const artifacts = generators.generateMany(
  ["typescript", "typescript-validator", "json-schema", "metadata-snapshot"],
  [Person],
);
```

First-party generation includes TypeScript interfaces/create-inputs/classes, dependency-free validators, JSON Schema draft 2020-12 and normalized metadata snapshots. `ArtifactGeneratorRegistry` is also the extension point for database-specific packages such as a future MySQL adapter. See `docs/code-generation.md`.

## Schema evolution

M8 compares versions semantically rather than textually.

```ts
const diff = diffObjectTypes(assetV1, assetV2);
const plan = new MigrationPlanner().plan(diff);
```

Changes are classified as `compatible`, `requires-migration`, or `breaking`. The migration planner emits ordered, database-neutral steps for metadata application, validation, backfill, data transformation, index rebuilds, cleanup and manual review. Adapter packages can register supplemental steps for dialect-specific work such as MySQL DDL.

`MetadataEvolution` connects the same diff/planning engine directly to persisted `MetadataCatalog` versions. See `docs/schema-evolution.md`.

## Metadata release pipeline

M9 coordinates M6–M8 into a governed release process.

```ts
const releases = new MetadataReleaseManager(catalog);

const preparation = await releases.prepare("example.asset", 2);
const result = await releases.release("example.asset", 2, {
  migrationExecutor,
  approveBreaking: true,
});
```

The release manager:

- compares the draft with the latest published version
- builds a semantic diff and migration plan
- blocks breaking changes until explicitly approved
- blocks migration-required releases until executable blocking steps have run
- rechecks the exact draft revision before publication
- publishes the prepared metadata version
- returns reproducible TypeScript, validator, JSON Schema and metadata artifacts

`prepareMany()` / `releaseMany()` extend the same guarantees to mutually dependent metadata graphs and publish them through `MetadataCatalog.publishMany()` after every draft revision and migration gate succeeds.

See `docs/metadata-release-pipeline.md`.

## Storage model

The core package defines `StorageAdapter` with insert, update, delete, get and query operations. `MemoryStorageAdapter` is the reference implementation and test harness.

Database-specific adapters remain separate packages:

```text
@nublox/metaobject-storage-mysql
@nublox/metaobject-storage-postgresql
@nublox/metaobject-storage-sqlite
```

## Implemented scope

The standalone kernel now includes metadata definitions and validation; compile-time inference; extensible attribute types; runtime object creation; defaults/nullability; first-class relationships; inheritance/composition; extensible constraints and behaviours; dirty tracking; serialization; optimistic concurrency; database-neutral querying; normalized metadata persistence; lifecycle-managed metadata publication; portable metadata bundles; TypeScript interfaces/create-inputs/classes; generated validators; JSON Schema; an extensible artifact generator registry; semantic schema diffs; compatibility classification; portable migration planning; and single/batch governed metadata release coordination.

## Roadmap

### M1 — Relationship engine ✅

Implemented: inverse synchronization, referential integrity, ownership metadata, collection mutation, graph navigation, batch persistence and delete policies.

### M2 — Inheritance and composition ✅

Implemented: resolved base types, inherited metadata, abstract/sealed semantics, lineage/type queries, subtype-compatible relationships, compile-time derived inference and exclusive composition lifecycle rules.

### M3 — Constraint and behaviour registry ✅

Implemented: custom constraints, cross-field rules, severity-aware validation, computed attributes, runtime behaviour registries, hooks, events, operations and inherited behaviour metadata.

### M4 — Query engine ✅

Implemented: logical groups, relationship traversal, projections, aggregates, cursor pagination, subtype expansion and metadata-aware planning.

### M5 — SQL storage adapters

External package milestone. Begin with MySQL while keeping database drivers outside this core package.

### M6 — Metadata persistence ✅

Implemented: normalized metadata rows, versioned store contract, optimistic catalogue revisions, lifecycle states, batch publication, runtime-registry loading and portable bundles.

### M7 — Code generation ✅

Implemented: TypeScript interfaces/create-inputs/classes, generated validators, JSON Schema, metadata artifacts and an adapter-extensible artifact generator registry.

### M8 — Schema evolution ✅

Implemented: semantic version diffs, compatibility classification, catalogue-backed comparisons, portable migration plans and adapter/application migration hooks.

### M9 — Metadata release pipeline ✅

Implemented: single and batch release preparation, migration execution gates, explicit breaking-change approval, optimistic release locking, publication coordination and generated release artifacts.

## Development

```bash
npm run check
```

This runs strict TypeScript checks, compile-time inference tests, builds the package and executes the runtime test suite with Node's built-in test runner.

## Licensing

The package is currently marked `UNLICENSED`. Choose and add the intended NuBlox licence before public package publication.
