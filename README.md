# @nublox/metaobject

A standalone, application-agnostic metadata-driven object model and runtime for TypeScript.

`@nublox/metaobject` turns object metadata into runtime objects with type enforcement, validation, relationships, change tracking, database-neutral querying, versioned metadata persistence, reproducible code generation, schema evolution planning, governed metadata releases and versioned metadata modules. It has no dependency on NuBlox application products or on any database engine.

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
- **Modules make dependencies explicit.** Capability-level metadata releases declare exact object versions and version-ranged module dependencies.
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

`normalizeObjectType()` flattens definitions into row collections suitable for `meta_object_type`, `meta_attribute`, constraints, relationships, indexes, rules, operations, events and hooks. See `docs/metadata-persistence.md`.

## Code generation

M7 provides reproducible TypeScript interfaces/create-inputs/classes, dependency-free validators, JSON Schema draft 2020-12 and normalized metadata snapshot artifacts. `ArtifactGeneratorRegistry` is the extension point for adapter-specific generators. See `docs/code-generation.md`.

## Schema evolution

M8 compares versions semantically and classifies changes as `compatible`, `requires-migration`, or `breaking`. `MigrationPlanner` emits portable validation, backfill, transformation, index, cleanup and manual-review steps, with adapter hooks for physical work. See `docs/schema-evolution.md`.

## Metadata release pipeline

M9 coordinates metadata persistence, evolution and generation into governed single or batch releases. It enforces breaking-change approval, blocking migration execution and exact draft-revision stability before publication. See `docs/metadata-release-pipeline.md`.

## Metadata modules

M10 groups exact object-type versions into versioned capability modules with explicit dependency ranges.

```ts
const modules = new MetadataModuleRegistry();

modules.register(defineMetadataModule({
  id: "identity",
  name: "Identity",
  version: 2,
  members: [{ objectTypeId: "nublox.person", version: 4 }],
}));

modules.register(defineMetadataModule({
  id: "assets",
  name: "Assets",
  version: 1,
  dependencies: [{ moduleId: "identity", minimumVersion: 2 }],
  members: [{ objectTypeId: "nublox.asset", version: 5 }],
}));
```

The module registry resolves highest-compatible dependency versions, rejects dependency cycles and diamond version conflicts, and returns dependency-first order. Module releases require dependency modules to be published, enforce one owning module per object type in the resolved graph, validate inheritance/relationship dependency ownership, and release all root-module schemas through the M9 batch pipeline.

See `docs/metadata-modules.md`.

## Storage model

The core package defines `StorageAdapter` with insert, update, delete, get and query operations. `MemoryStorageAdapter` is the reference implementation and test harness.

Database-specific adapters remain separate packages:

```text
@nublox/metaobject-storage-mysql
@nublox/metaobject-storage-postgresql
@nublox/metaobject-storage-sqlite
```

## Implemented scope

The standalone kernel now includes metadata definitions and validation; compile-time inference; extensible attribute types; runtime objects; first-class relationships; inheritance/composition; extensible constraints and behaviours; dirty tracking; serialization; optimistic concurrency; database-neutral querying; normalized metadata persistence; governed publication; portable metadata bundles; TypeScript/validator/JSON Schema generation; semantic schema evolution; portable migration planning; single/batch release coordination; and versioned metadata modules with dependency resolution and module-wide releases.

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

### M10 — Metadata modules ✅
Implemented: versioned module definitions, dependency ranges, deterministic dependency resolution, cycle/version-conflict detection, explicit object-type ownership, module manifests and module-wide governed releases.

## Development

```bash
npm run check
```

This runs strict TypeScript checks, compile-time inference tests, builds the package and executes the runtime test suite with Node's built-in test runner.

## Licensing

The package is currently marked `UNLICENSED`. Choose and add the intended NuBlox licence before public package publication.
