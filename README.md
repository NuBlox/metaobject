# @nublox/metaobject

A standalone, application-agnostic metadata-driven object model and runtime for TypeScript.

`@nublox/metaobject` turns object metadata into runtime objects with type enforcement, validation, relationships, change tracking, database-neutral querying, versioned metadata persistence, persistence contracts and reproducible code generation. It has no dependency on NuBlox application products or on any database engine.

## Design principles

- **Metadata is the source of truth.** Object definitions describe attributes, types, relationships, constraints, behaviours and indexes.
- **Compile-time and runtime models coexist.** Literal metadata can infer TypeScript shapes; JSON/database metadata receives the same runtime validation.
- **Storage is pluggable.** Core exposes storage contracts rather than embedding MySQL, PostgreSQL or another database.
- **Relationships are first-class.** `ObjectGraph` coordinates bidirectional relationship semantics.
- **Behaviours remain serializable.** Metadata stores stable handler names; executable functions live in registries.
- **Queries are database-neutral.** Rich query planning sits above storage and can later be pushed down by adapters.
- **Metadata persistence is normalized.** Definitions flatten into database-ready metadata records.
- **Generated artifacts are reproducible.** TypeScript, validators, JSON Schema and adapter artifacts are regenerated from metadata rather than becoming a second source of truth.
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

M7 expands code generation from a minimal interface emitter into a reproducible artifact system.

```ts
const generators = createDefaultArtifactGeneratorRegistry();
const artifacts = generators.generateMany(
  ["typescript", "typescript-validator", "json-schema", "metadata-snapshot"],
  [Person],
);
```

First-party generation includes:

- TypeScript value interfaces
- create-input interfaces that omit computed attributes by default
- immutable typed model wrappers
- dependency-free TypeScript validators
- JSON Schema draft 2020-12
- normalized metadata snapshot artifacts

`ArtifactGeneratorRegistry` is also the extension point for database-specific packages. A future `@nublox/metaobject-storage-mysql` package can register MySQL DDL and mapping generators without adding a MySQL dependency to core.

See `docs/code-generation.md`.

## Storage model

The core package defines `StorageAdapter` with insert, update, delete, get and query operations. `MemoryStorageAdapter` is the reference implementation and test harness.

Database-specific adapters remain separate packages:

```text
@nublox/metaobject-storage-mysql
@nublox/metaobject-storage-postgresql
@nublox/metaobject-storage-sqlite
```

## Implemented scope

The standalone kernel now includes metadata definitions and validation; compile-time inference; extensible attribute types; runtime object creation; defaults/nullability; first-class relationships; inheritance/composition; extensible constraints and behaviours; dirty tracking; serialization; optimistic concurrency; database-neutral querying; normalized metadata persistence; lifecycle-managed metadata publication; portable metadata bundles; TypeScript interfaces/create-inputs/classes; generated validators; JSON Schema; and an extensible artifact generator registry.

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

### M8 — Schema evolution

Calculate metadata differences, classify compatibility and provide migration planning hooks.

## Development

```bash
npm run check
```

This runs strict TypeScript checks, compile-time inference tests, builds the package and executes the runtime test suite with Node's built-in test runner.

## Licensing

The package is currently marked `UNLICENSED`. Choose and add the intended NuBlox licence before public package publication.
