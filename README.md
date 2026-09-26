# @nublox/metaobject

A standalone, application-agnostic metadata-driven object model and runtime for TypeScript.

`@nublox/metaobject` turns object metadata into runtime objects with type enforcement, validation, relationships, change tracking, abstract querying, persistence contracts and optional TypeScript code generation. It has no dependency on NuBlox application products or on any database engine.

## Design principles

- **Metadata is the source of truth.** Object definitions describe attributes, types, relationships, constraints and indexes.
- **Compile-time and runtime models coexist.** Metadata declared with `as const` can infer TypeScript value shapes; metadata loaded from JSON or a database receives the same runtime validation.
- **Storage is pluggable.** The core package exposes a storage contract rather than embedding MySQL, PostgreSQL or another database.
- **Relationships are first-class.** Object relationships are distinct from primitive attributes and can be coordinated bidirectionally through `ObjectGraph`.
- **Type systems are extensible.** Applications can register additional attribute types without changing the kernel.
- **Optimistic concurrency is part of the object contract.** Storage adapters enforce version checks consistently.

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

const person = factory.create(Person, {
  firstName: "Stephen",
  age: 41,
});

await repository.save(person);
```

The `factory.create(Person, ...)` overload infers the value shape directly from the metadata. Passing a string type id instead supports fully dynamic metadata loaded at runtime.

## Built-in attribute types

- `string`
- `integer`
- `number`
- `decimal`
- `boolean`
- `date`
- `datetime`
- `uuid`
- `json`
- `binary`

Additional types implement `AttributeType<T>` and are registered through `TypeRegistry`.

## Runtime object states

Objects transition through:

```text
new -> clean -> dirty -> clean
       |         |
       +-------> deleted
```

`detached` is also available for objects intentionally removed from a persistence context.

## Relationship engine

M1 adds graph-level relationship semantics without coupling objects to a database or ORM.

```ts
const graph = new ObjectGraph(objects);

graph.connect(team, "members", person);

team.relationshipReferences("members");
person.getRelationship("team");

graph.disconnect(team, "members", person);
```

Relationship metadata supports:

- one-to-one, one-to-many, many-to-one and many-to-many cardinality
- inverse relationship validation and synchronization
- source/target ownership metadata
- ordered to-many collections
- required relationships
- `restrict`, `cascade` and `detach` referential actions
- independent relationship dirty/change tracking
- compile-time `InferRelationships<T>` inference

Ownership is descriptive and does not implicitly delete objects. Lifecycle propagation is controlled explicitly with `onSourceDelete` and `onTargetDelete`, preventing accidental cascades.

M2 adds single inheritance and semantic relationship kinds. `ObjectTypeRegistry.resolve()` flattens inherited metadata, `isA()` drives subtype assignment, and `defineDerivedObjectType()` preserves inherited compile-time shapes. Composition adds exclusive parentage and source-owned lifecycle cascade. See `docs/inheritance-composition.md`.

`MetaObjectRepository` validates persisted references by default. New cyclic or bidirectional object graphs can be persisted through `saveAll()`, which treats references between objects in the same batch as valid:

```ts
await repository.saveAll([team, person]);
```

## Storage model

The core package defines `StorageAdapter` with insert, update, delete, get and query operations. `MemoryStorageAdapter` provides the M0 reference implementation and test harness.

Database-specific adapters should be separate packages, for example:

```text
@nublox/metaobject-storage-mysql
@nublox/metaobject-storage-postgresql
@nublox/metaobject-storage-sqlite
```

## Query model

Queries are database-independent:

```ts
const adults = await repository.query({
  objectType: "example.person",
  where: [
    { attribute: "age", operator: "gte", value: 18 },
  ],
  orderBy: [
    { attribute: "age", direction: "desc" },
  ],
});
```

Adapters translate this query AST to their native query language.

## Implemented scope

The standalone kernel now includes:

- metadata definitions
- metadata registry and validation
- compile-time value inference
- extensible attribute type registry
- dynamic object factory
- typed attribute enforcement
- defaults and nullability
- first-class object references/relationships
- validation constraints
- dirty tracking
- serialization and snapshots
- object identity and versioning
- storage adapter contract
- in-memory persistence adapter
- abstract query model
- optimistic concurrency
- minimal TypeScript interface generation
- inverse relationship validation and synchronization
- graph navigation through `ObjectGraph`
- ordered relationship collection mutation
- relationship change tracking
- referential integrity checks
- batch persistence for cyclic graphs
- explicit detach/restrict/cascade delete semantics
- compile-time relationship inference
- resolved single inheritance and type lineage
- abstract and sealed object semantics
- compile-time derived metadata inference
- polymorphic relationship assignment
- aggregation/composition relationship kinds
- exclusive composite-parent enforcement
- composition lifecycle cascade

## Roadmap

### M1 — Relationship engine ✅

Implemented: inverse synchronization, referential integrity, ownership metadata, collection mutation, graph navigation, batch persistence and delete policies.

### M2 — Inheritance and composition ✅

Implemented: resolved base types, inherited attributes/relationships/indexes/defaults, abstract/sealed semantics, lineage/type queries, subtype-compatible relationships, compile-time derived metadata inference and exclusive composition lifecycle rules.

### M3 — Constraint and behaviour registry

Custom constraints, cross-field rules, computed attributes, hooks, events and operations.

### M4 — Query engine

Logical groups, relationship traversal, projections, aggregates, cursor pagination and query planning.

### M5 — SQL storage adapters

Begin with MySQL while keeping dialect implementation outside the core package.

### M6 — Metadata persistence

Persist `ObjectType`, `Attribute`, `AttributeType`, `Relationship`, constraints, indexes and schema versions as data.

### M7 — Code generation

Generate TypeScript interfaces/classes, validators, JSON Schema and adapter-specific artifacts.

### M8 — Schema evolution

Version metadata, calculate differences and provide migration planning hooks.

## Development

```bash
npm run check
```

This runs strict TypeScript checks, compile-time inference tests, builds the package and executes the runtime test suite with Node's built-in test runner.

## Licensing

The package is currently marked `UNLICENSED`. Choose and add the intended NuBlox licence before public package publication.
